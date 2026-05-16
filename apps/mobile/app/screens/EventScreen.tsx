/**
 * Event feed screen — the app's home screen (`/`).
 *
 * Responsibilities:
 *  - Fetch all events from Supabase and render them as a sorted, filterable list.
 *  - Batch-fetch RSVP counts and creator profiles to enrich each EventItem.
 *  - Provide a full-screen map view with the same event data and filter chips.
 *  - Track and display the unread notification count on the bell icon.
 *
 * Data flow (on every screen focus):
 *  1. Parallel fetch: all events (`select *`) + all RSVPs (`select event_id`).
 *  2. Build a countMap { [event_id]: number } from the RSVP rows client-side.
 *  3. Collect unique creator IDs → batch-fetch display names from profiles.
 *  4. Map each DBEvent row through toEventItem() (imported from lib/utils) to
 *     produce EventItem objects consumed by EventCard and the map markers.
 *
 * Performance notes:
 *  - RSVP counts use a single "fetch all RSVPs" + client-side map rather than
 *    N individual count queries. This is acceptable at current scale; at high
 *    volume a DB view or aggregate column would be more efficient.
 *  - useFocusEffect (not useEffect) ensures data refreshes after RSVP changes
 *    made on the detail screen are reflected when the user navigates back.
 *
 * Filtering:
 *  - Multi-select OR logic: an event matches if it satisfies ANY active filter.
 *  - "Nearby" filter requests device location and shows events within 0.5 km.
 *  - Search is a client-side substring match on title, org, and location.
 *
 * Security:
 *  - All data is read-only on this screen. Supabase RLS allows public read
 *    access to events and rsvps (read-only policies).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  FlatList,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Linking,
  Animated,
  Alert,
  Image,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import MapView, { Marker, Region } from "react-native-maps";
import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";
import { useFocusEffect, useRouter } from "expo-router";
import EventCard, { EventItem } from "../components/EventCard";
import BottomNav from "../components/BottomNav";
import { supabase, DBEvent } from "../../lib/supabase";
import { ACCENT } from "../../lib/constants";
import { toEventItem, parseDateStr } from "../../lib/utils";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const LOGO = require("../../assets/uSpot.png");

type FilterKey =
  | "today"
  | "tomorrow"
  | "free_food"
  | "social"
  | "academic"
  | "workshop"
  | "sports"
  | "nearby";

type Mode = "events" | "map";

const UVA_REGION: Region = {
  latitude: 38.0336,
  longitude: -78.508,
  latitudeDelta: 0.012,
  longitudeDelta: 0.012,
};

const FILTER_CHIPS: Array<{ key: FilterKey; label: string }> = [
  { key: "today",     label: "Today 📅"    },
  { key: "tomorrow",  label: "Tomorrow"    },
  { key: "free_food", label: "Free Food 🍕" },
  { key: "social",    label: "Social 🎉"   },
  { key: "academic",  label: "Academic 📚" },
  { key: "workshop",  label: "Workshop 🔧" },
  { key: "sports",    label: "Sports ⚽"   },
  { key: "nearby",    label: "Nearby 📍"   },
];

const MAP_CHIPS: Array<{ key: FilterKey; label: string; icon: string }> = [
  { key: "today",     label: "Today",     icon: "today-outline"     },
  { key: "tomorrow",  label: "Tomorrow",  icon: "calendar-outline"  },
  { key: "free_food", label: "Free Food", icon: "fast-food-outline" },
  { key: "social",    label: "Social",    icon: "people-outline"    },
  { key: "academic",  label: "Academic",  icon: "school-outline"    },
  { key: "workshop",  label: "Workshop",  icon: "hammer-outline"    },
  { key: "sports",    label: "Sports",    icon: "football-outline"  },
  { key: "nearby",    label: "Nearby",    icon: "navigate-outline"  },
];

/** Haversine distance in kilometres between two lat/lng points. */
function haversineKm(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Returns a sort key for a date string so events are displayed chronologically.
 * Events without a date sort to the end (Infinity).
 */
function dateOrder(date?: string): number {
  if (!date) return Infinity;
  if (date === "Today")    return 0;
  if (date === "Tomorrow") return 1;
  const p = parseDateStr(date);
  return p ? p.getTime() : Infinity;
}

function openDirections(lat: number, lng: number, label: string) {
  const encoded = encodeURIComponent(label);
  const url =
    Platform.OS === "ios"
      ? `maps://?daddr=${lat},${lng}&q=${encoded}`
      : `geo:${lat},${lng}?q=${lat},${lng}(${encoded})`;
  Linking.openURL(url).catch(() =>
    Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`)
  );
}

/** FlatList row type — section headers interleaved with event rows. */
type ListRow =
  | { type: "header"; date: string }
  | { type: "event"; event: EventItem };

export default function EventScreen() {
  const router = useRouter();

  const [mode, setMode]                   = useState<Mode>("events");
  const [activeFilters, setActiveFilters] = useState<Set<FilterKey>>(new Set());
  const [search, setSearch]               = useState("");
  const [isSearching, setIsSearching]     = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<EventItem | null>(null);
  const [events, setEvents]               = useState<EventItem[]>([]);
  const [loading, setLoading]             = useState(true);
  const [userLocation, setUserLocation]   = useState<{ latitude: number; longitude: number } | null>(null);
  const [unreadCount, setUnreadCount]     = useState(0);

  // Re-fetch every time this screen comes into focus so RSVP state from the
  // detail screen is reflected immediately on return.
  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      Promise.all([
        supabase.from("events").select("*"),
        supabase.from("rsvps").select("event_id"),
      ]).then(async ([eventsRes, rsvpsRes]) => {
        if (!eventsRes.error && eventsRes.data) {
          // Build RSVP count map in a single pass to avoid N queries.
          const countMap: Record<string, number> = {};
          rsvpsRes.data?.forEach((r: any) => {
            countMap[r.event_id] = (countMap[r.event_id] ?? 0) + 1;
          });

          // Batch-fetch creator display names for the "Posted by" section in detail.
          const creatorIds = [
            ...new Set(
              (eventsRes.data as DBEvent[])
                .map((e) => e.created_by)
                .filter((id): id is string => !!id)
            ),
          ];
          const profileMap: Record<string, string> = {};
          if (creatorIds.length > 0) {
            const { data: profiles } = await supabase
              .from("profiles")
              .select("id, full_name")
              .in("id", creatorIds);
            profiles?.forEach((p: any) => {
              profileMap[p.id] = p.full_name ?? "";
            });
          }

          setEvents(
            (eventsRes.data as DBEvent[]).map((row) =>
              toEventItem(
                row,
                countMap[row.id] ?? 0,
                row.created_by ? profileMap[row.created_by] || undefined : undefined
              )
            )
          );
        }
        setLoading(false);
      });

      // Update notification badge separately — failure here should not block the feed.
      supabase.auth.getUser().then(({ data: { user } }) => {
        if (!user) return;
        supabase
          .from("notifications")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .eq("read", false)
          .then(({ count }) => setUnreadCount(count ?? 0));
      });
    }, [])
  );

  // Request location permission when the Nearby filter is first toggled on.
  useEffect(() => {
    if (!activeFilters.has("nearby") || userLocation) return;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        setActiveFilters((prev) => {
          const next = new Set(prev);
          next.delete("nearby");
          return next;
        });
        Alert.alert(
          "Location needed",
          "Enable location access to use the Nearby filter."
        );
        return;
      }
      const pos = await Location.getCurrentPositionAsync({});
      setUserLocation({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      });
    })();
  }, [activeFilters]);

  // ── Animated values for search bar and map sheet ──────────────────────────

  const searchAnim = useRef(new Animated.Value(0)).current;
  const sheetAnim  = useRef(new Animated.Value(0)).current;
  const searchInputRef = useRef<TextInput>(null);

  const openSearch = () => {
    setIsSearching(true);
    Animated.timing(searchAnim, { toValue: 1, duration: 200, useNativeDriver: true }).start(
      () => searchInputRef.current?.focus()
    );
  };

  const closeSearch = () => {
    setSearch("");
    Animated.timing(searchAnim, { toValue: 0, duration: 180, useNativeDriver: true }).start(
      () => setIsSearching(false)
    );
  };

  const selectEvent = (event: EventItem | null) => {
    if (event) {
      setSelectedEvent(event);
      Animated.spring(sheetAnim, {
        toValue: 1, useNativeDriver: true, tension: 60, friction: 10,
      }).start();
    } else {
      Animated.timing(sheetAnim, { toValue: 0, duration: 180, useNativeDriver: true }).start(
        () => setSelectedEvent(null)
      );
    }
  };

  const switchMode = (next: Mode) => {
    selectEvent(null);
    if (next === "map") {
      setSearch("");
      setIsSearching(false);
      searchAnim.setValue(0);
    }
    setMode(next);
  };

  const toggleFilter = (key: FilterKey) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // ── Filtering (multi-select OR logic) ────────────────────────────────────

  const filtered = useMemo(() => {
    let result = events;

    if (activeFilters.size > 0) {
      result = result.filter((e) => {
        if (activeFilters.has("today")     && e.date === "Today")    return true;
        if (activeFilters.has("tomorrow")  && e.date === "Tomorrow") return true;
        if (activeFilters.has("free_food") && e.hasFreeFood)         return true;
        if (activeFilters.has("social")    && e.categories?.includes("social"))   return true;
        if (activeFilters.has("academic")  && e.categories?.includes("academic")) return true;
        if (activeFilters.has("workshop")  && e.categories?.includes("workshop")) return true;
        if (activeFilters.has("sports")    && e.categories?.includes("sports"))   return true;
        if (
          activeFilters.has("nearby") &&
          userLocation &&
          e.coordinates &&
          haversineKm(
            userLocation.latitude, userLocation.longitude,
            e.coordinates.latitude, e.coordinates.longitude
          ) <= 0.5
        ) return true;
        return false;
      });
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          e.org.toLowerCase().includes(q) ||
          e.location.toLowerCase().includes(q)
      );
    }

    return result;
  }, [events, activeFilters, search, userLocation]);

  // Build FlatList rows with date section headers, sorted chronologically.
  const listRows = useMemo<ListRow[]>(() => {
    const sorted = [...filtered].sort((a, b) => dateOrder(a.date) - dateOrder(b.date));
    const rows: ListRow[] = [];
    let lastDate = "";
    for (const event of sorted) {
      if (event.date && event.date !== lastDate) {
        rows.push({ type: "header", date: event.date });
        lastDate = event.date;
      }
      rows.push({ type: "event", event });
    }
    return rows;
  }, [filtered]);

  const normalHeaderOpacity = searchAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const searchHeaderOpacity = searchAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });
  const sheetTranslateY     = sheetAnim.interpolate({ inputRange: [0, 1], outputRange: [300, 0] });

  const openDetail = (event: EventItem) => {
    router.push({
      pathname: `/event/${event.id}`,
      params: { event: JSON.stringify(event) },
    });
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#000" }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* ── Events mode header ── */}
        {mode === "events" && (
          <View style={{ paddingTop: 6, paddingBottom: 4 }}>
            <View style={{ height: 44, marginHorizontal: 16, marginBottom: 14 }}>
              {/* Normal header: logo + search + notifications */}
              <Animated.View
                pointerEvents={isSearching ? "none" : "auto"}
                style={{
                  position: "absolute", left: 0, right: 0, top: 0, bottom: 0,
                  flexDirection: "row", alignItems: "center",
                  justifyContent: "space-between",
                  opacity: normalHeaderOpacity,
                }}
              >
                <Image
                  source={LOGO}
                  style={{ height: 28, width: 100 }}
                  resizeMode="contain"
                  tintColor="#fff"
                />
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Pressable
                    onPress={openSearch}
                    style={{
                      width: 38, height: 38, borderRadius: 19,
                      backgroundColor: "#1C1C1E",
                      alignItems: "center", justifyContent: "center",
                    }}
                  >
                    <Ionicons name="search-outline" size={18} color="#fff" />
                  </Pressable>
                  <Pressable
                    onPress={() => router.push("/notifications")}
                    style={{
                      width: 38, height: 38, borderRadius: 19,
                      backgroundColor: "#1C1C1E",
                      alignItems: "center", justifyContent: "center",
                    }}
                  >
                    <Ionicons name="notifications-outline" size={18} color="#fff" />
                    {/* Red dot badge for unread notifications */}
                    {unreadCount > 0 && (
                      <View
                        style={{
                          position: "absolute", top: 7, right: 7,
                          width: 8, height: 8, borderRadius: 4,
                          backgroundColor: "#E5403A",
                          borderWidth: 1.5, borderColor: "#000",
                        }}
                      />
                    )}
                  </Pressable>
                </View>
              </Animated.View>

              {/* Search bar — slides in over the normal header. */}
              {isSearching && (
                <Animated.View
                  style={{
                    position: "absolute", left: 0, right: 0, top: 0, bottom: 0,
                    flexDirection: "row", alignItems: "center", gap: 10,
                    opacity: searchHeaderOpacity,
                  }}
                >
                  <Pressable onPress={closeSearch} style={{ padding: 4 }}>
                    <Ionicons name="chevron-back" size={22} color="#fff" />
                  </Pressable>
                  <View
                    style={{
                      flex: 1, height: 38, backgroundColor: "#1C1C1E",
                      borderRadius: 999, paddingHorizontal: 14,
                      flexDirection: "row", alignItems: "center", gap: 8,
                    }}
                  >
                    <Ionicons name="search-outline" size={15} color="#555" />
                    <TextInput
                      ref={searchInputRef}
                      value={search}
                      onChangeText={setSearch}
                      placeholder="Search events, orgs, locations…"
                      placeholderTextColor="#444"
                      returnKeyType="search"
                      style={{ flex: 1, color: "#fff", fontSize: 15 }}
                    />
                    {search.length > 0 && (
                      <Pressable onPress={() => setSearch("")}>
                        <Ionicons name="close-circle" size={16} color="#555" />
                      </Pressable>
                    )}
                  </View>
                </Animated.View>
              )}
            </View>

            {/* Events / Map toggle */}
            <View
              style={{
                flexDirection: "row", backgroundColor: "#1C1C1E",
                borderRadius: 14, padding: 4, marginHorizontal: 16,
              }}
            >
              {(["events", "map"] as Mode[]).map((m) => {
                const active = mode === m;
                return (
                  <Pressable
                    key={m}
                    onPress={() => switchMode(m)}
                    style={{
                      flex: 1, flexDirection: "row", alignItems: "center",
                      justifyContent: "center", gap: 6, paddingVertical: 11,
                      borderRadius: 10,
                      backgroundColor: active ? "#fff" : "transparent",
                    }}
                  >
                    <Ionicons
                      name={m === "events" ? "calendar-outline" : "map-outline"}
                      size={16}
                      color={active ? "#000" : "#666"}
                    />
                    <Text
                      style={{
                        color: active ? "#000" : "#666",
                        fontWeight: "700", fontSize: 14,
                      }}
                    >
                      {m === "events" ? "Events" : "Map"}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Filter chips */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{
                paddingHorizontal: 16, gap: 8,
                paddingTop: 14, paddingBottom: 2,
              }}
            >
              {FILTER_CHIPS.map((chip) => {
                const active = activeFilters.has(chip.key);
                return (
                  <Pressable
                    key={chip.key}
                    onPress={() => toggleFilter(chip.key)}
                    style={{
                      paddingHorizontal: 16, paddingVertical: 8, borderRadius: 999,
                      backgroundColor: active ? "#fff" : "transparent",
                      borderWidth: 1, borderColor: active ? "#fff" : "#2C2C2C",
                    }}
                  >
                    <Text
                      style={{
                        color: active ? "#000" : "#777",
                        fontWeight: active ? "700" : "500",
                        fontSize: 14,
                      }}
                    >
                      {chip.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        )}

        {/* ── Content area ── */}
        <View style={{ flex: 1 }}>
          {mode === "events" ? (
            loading ? (
              <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                <ActivityIndicator size="large" color={ACCENT} />
              </View>
            ) : listRows.length === 0 ? (
              <View
                style={{
                  flex: 1, alignItems: "center", justifyContent: "center", gap: 10,
                }}
              >
                <Ionicons name="search-outline" size={40} color="#2A2A2A" />
                <Text style={{ color: "#555", fontSize: 15 }}>
                  No events match this filter
                </Text>
              </View>
            ) : (
              <FlatList
                data={listRows}
                keyExtractor={(row) =>
                  row.type === "header" ? `hdr-${row.date}` : row.event.id
                }
                contentContainerStyle={{
                  paddingHorizontal: 16,
                  paddingBottom: 120,
                  paddingTop: 8,
                }}
                showsVerticalScrollIndicator={false}
                renderItem={({ item: row }) => {
                  if (row.type === "header") {
                    return (
                      <Text
                        style={{
                          color: "#555", fontSize: 11, fontWeight: "700",
                          letterSpacing: 0.8, marginBottom: 10, marginTop: 6,
                        }}
                      >
                        {row.date.toUpperCase()}
                      </Text>
                    );
                  }
                  return (
                    <View style={{ marginBottom: 12 }}>
                      <EventCard
                        item={row.event}
                        onPress={() => openDetail(row.event)}
                      />
                    </View>
                  );
                }}
              />
            )
          ) : (
            /* ── Full-screen map ── */
            <Pressable style={{ flex: 1 }} onPress={() => selectEvent(null)}>
              <MapView
                style={{ flex: 1 }}
                initialRegion={UVA_REGION}
                userInterfaceStyle="dark"
                showsUserLocation
                showsCompass={false}
              >
                {filtered.map((event) =>
                  event.coordinates ? (
                    <Marker
                      key={event.id}
                      coordinate={event.coordinates}
                      onPress={(e) => {
                        e.stopPropagation();
                        selectEvent(event);
                      }}
                    >
                      <View
                        style={{
                          width: 40, height: 40, borderRadius: 20,
                          backgroundColor: event.color,
                          alignItems: "center", justifyContent: "center",
                          borderWidth: 2.5, borderColor: "#fff",
                          shadowColor: "#000",
                          shadowOffset: { width: 0, height: 2 },
                          shadowOpacity: 0.4, shadowRadius: 4, elevation: 5,
                        }}
                      >
                        <Ionicons
                          name={event.hasFreeFood ? "fast-food" : "calendar"}
                          size={17}
                          color="#fff"
                        />
                      </View>
                    </Marker>
                  ) : null
                )}
              </MapView>

              {/* Map overlay — back button, logo, filter chips */}
              <View
                style={{
                  position: "absolute", top: 14, left: 16, right: 16,
                  gap: 10, pointerEvents: "box-none",
                }}
              >
                <View
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <Pressable
                    onPress={() => switchMode("events")}
                    style={{
                      flexDirection: "row", alignItems: "center", gap: 6,
                      backgroundColor: "rgba(0,0,0,0.65)",
                      paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999,
                    }}
                  >
                    <Ionicons name="chevron-back" size={16} color="#fff" />
                    <Text style={{ color: "#fff", fontWeight: "700", fontSize: 14 }}>
                      List
                    </Text>
                  </Pressable>
                  <Image
                    source={LOGO}
                    style={{ height: 24, width: 90 }}
                    resizeMode="contain"
                    tintColor="#fff"
                  />
                  <Pressable
                    onPress={() =>
                      Alert.alert("Notifications", "No new notifications right now.")
                    }
                    style={{
                      width: 38, height: 38, borderRadius: 19,
                      backgroundColor: "rgba(0,0,0,0.65)",
                      alignItems: "center", justifyContent: "center",
                    }}
                  >
                    <Ionicons name="notifications-outline" size={18} color="#fff" />
                  </Pressable>
                </View>

                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 8 }}
                  pointerEvents="box-none"
                >
                  {MAP_CHIPS.map((c) => {
                    const active = activeFilters.has(c.key);
                    return (
                      <Pressable
                        key={c.key}
                        onPress={() => toggleFilter(c.key)}
                        style={{
                          flexDirection: "row", alignItems: "center", gap: 6,
                          paddingHorizontal: 13, height: 34, borderRadius: 999,
                          backgroundColor: active
                            ? "rgba(255,255,255,0.95)"
                            : "rgba(0,0,0,0.65)",
                        }}
                      >
                        <Ionicons
                          name={c.icon as any}
                          size={14}
                          color={active ? "#000" : "#fff"}
                        />
                        <Text
                          style={{
                            color: active ? "#000" : "#fff",
                            fontWeight: "600", fontSize: 13,
                          }}
                        >
                          {c.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            </Pressable>
          )}
        </View>

        {/* Floating bottom nav */}
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 18 }}>
          <BottomNav />
        </View>

        {/* Map event detail sheet — springs up from the bottom when a marker is tapped. */}
        {selectedEvent && (
          <Animated.View
            style={{
              position: "absolute", left: 16, right: 16, bottom: 90,
              transform: [{ translateY: sheetTranslateY }],
            }}
          >
            <View
              style={{
                backgroundColor: "#1C1C1E", borderRadius: 20, overflow: "hidden",
                shadowColor: "#000",
                shadowOffset: { width: 0, height: -4 },
                shadowOpacity: 0.5, shadowRadius: 12, elevation: 10,
              }}
            >
              <View style={{ height: 5, backgroundColor: selectedEvent.color }} />
              <View style={{ padding: 16 }}>
                <View
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                  }}
                >
                  <View style={{ flex: 1, marginRight: 12 }}>
                    <Text style={{ color: "#fff", fontSize: 17, fontWeight: "700" }}>
                      {selectedEvent.title}
                    </Text>
                    <Text style={{ color: "#888", fontSize: 13, marginTop: 2 }}>
                      {selectedEvent.org}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => selectEvent(null)}
                    style={{
                      width: 28, height: 28, borderRadius: 14,
                      backgroundColor: "#2A2A2A",
                      alignItems: "center", justifyContent: "center",
                    }}
                  >
                    <Ionicons name="close" size={16} color="#888" />
                  </Pressable>
                </View>

                <View style={{ marginTop: 12, gap: 8 }}>
                  {selectedEvent.time && (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Ionicons name="time-outline" size={14} color="#666" />
                      <Text style={{ color: "#bbb", fontSize: 14 }}>
                        {selectedEvent.date} · {selectedEvent.time}
                      </Text>
                    </View>
                  )}
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Ionicons name="location-outline" size={14} color="#666" />
                    <Text style={{ color: "#bbb", fontSize: 14 }}>
                      {selectedEvent.location}
                    </Text>
                  </View>
                </View>

                <View style={{ flexDirection: "row", gap: 10, marginTop: 14 }}>
                  <Pressable
                    onPress={() => { selectEvent(null); openDetail(selectedEvent); }}
                    style={{
                      flex: 1, borderRadius: 12, paddingVertical: 11,
                      backgroundColor: "#2A2A2A",
                      flexDirection: "row", alignItems: "center",
                      justifyContent: "center", gap: 6,
                    }}
                  >
                    <Ionicons name="information-circle-outline" size={15} color="#fff" />
                    <Text style={{ color: "#fff", fontWeight: "600", fontSize: 14 }}>
                      Details
                    </Text>
                  </Pressable>

                  {selectedEvent.coordinates && (
                    <Pressable
                      onPress={() =>
                        openDirections(
                          selectedEvent.coordinates!.latitude,
                          selectedEvent.coordinates!.longitude,
                          selectedEvent.location
                        )
                      }
                      style={{
                        flex: 1, backgroundColor: selectedEvent.color,
                        borderRadius: 12, paddingVertical: 11,
                        flexDirection: "row", alignItems: "center",
                        justifyContent: "center", gap: 6,
                      }}
                    >
                      <Ionicons name="navigate" size={15} color="#fff" />
                      <Text style={{ color: "#fff", fontWeight: "700", fontSize: 14 }}>
                        Directions
                      </Text>
                    </Pressable>
                  )}
                </View>
              </View>
            </View>
          </Animated.View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
