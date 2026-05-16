/**
 * Event detail screen — `/event/[id]`
 *
 * Receives a serialised EventItem via navigation params (fast initial render),
 * then fetches fresh live data from the DB on mount.
 *
 * Data fetched on mount:
 *  - Current user's RSVP status for this event
 *  - Current user's display name (for optimistic attendee insertion)
 *  - Creator's full_name and avatar_url (re-fetched fresh — not from params —
 *    so profile updates are always reflected)
 *  - All RSVP rows (up to 24) for the attendee grid
 *  - Profile rows for each attendee (batch fetch, not N+1)
 *
 * RSVP toggle:
 *  Uses optimistic local state updates rather than Supabase Realtime. Realtime
 *  was removed after a channel collision error caused by React StrictMode running
 *  effects twice in development (same channel name registered twice).
 *
 * Security:
 *  - Only authenticated users can RSVP (Supabase RLS: INSERT requires auth.uid()).
 *  - Creator check is done client-side for UX (showing Manage vs RSVP button)
 *    and enforced server-side by RLS on the events table.
 *  - params.event is parsed defensively with try/catch — a navigation attempt
 *    with malformed JSON will not crash the app.
 */

import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Image,
  Platform,
  Linking,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { EventItem } from "../components/EventCard";
import { supabase } from "../../lib/supabase";
import { ACCENT } from "../../lib/constants";
import { avatarColor } from "../../lib/utils";

const CATEGORY_META: Record<string, { label: string; icon: string; color: string }> = {
  social:    { label: "Social",    icon: "people-outline",              color: "#B12BE5" },
  academic:  { label: "Academic",  icon: "school-outline",              color: "#2B6FE5" },
  free_food: { label: "Free Food", icon: "fast-food-outline",           color: ACCENT    },
  workshop:  { label: "Workshop",  icon: "hammer-outline",              color: "#2BE59A" },
  sports:    { label: "Sports",    icon: "football-outline",            color: "#E5403A" },
  other:     { label: "Other",     icon: "ellipsis-horizontal-outline", color: "#888"    },
};

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

export default function EventDetail() {
  const router = useRouter();
  const { top } = useSafeAreaInsets();
  const params = useLocalSearchParams<{ event: string }>();

  // Defensive parse — malformed params must not crash the app.
  let event: EventItem;
  try {
    event = JSON.parse(params.event);
  } catch {
    // If params are missing or corrupt, go back rather than rendering broken UI.
    router.back();
    return null;
  }

  const [rsvpCount, setRsvpCount]     = useState(event.rsvpCount ?? 0);
  const [hasRsvp, setHasRsvp]         = useState(false);
  const [isCreator, setIsCreator]     = useState(false);
  const [rsvpLoading, setRsvpLoading] = useState(false);
  const [currentUserId, setCurrentUserId]     = useState<string | null>(null);
  const [currentUserName, setCurrentUserName] = useState("Member");
  const [attendees, setAttendees] = useState<
    { userId: string; name: string; avatarUrl?: string }[]
  >([]);
  // Creator profile — re-fetched from DB so name and photo are always current.
  const [creatorDisplayName, setCreatorDisplayName] = useState(event.creatorName ?? "");
  const [creatorAvatarUrl, setCreatorAvatarUrl]     = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!active) return;

      if (user) {
        setCurrentUserId(user.id);
        setIsCreator(user.id === event.createdBy);

        // Fetch current user's RSVP status and display name in parallel.
        const [myRsvp, profileRes] = await Promise.all([
          supabase
            .from("rsvps")
            .select("id")
            .eq("event_id", event.id)
            .eq("user_id", user.id)
            .maybeSingle(),
          supabase
            .from("profiles")
            .select("full_name")
            .eq("id", user.id)
            .single(),
        ]);
        if (!active) return;
        setHasRsvp(!!myRsvp.data);
        if (profileRes.data?.full_name) setCurrentUserName(profileRes.data.full_name);
      }

      // Fetch the live RSVP list and the creator's current profile in parallel.
      const [rsvpRes, creatorRes] = await Promise.all([
        supabase
          .from("rsvps")
          .select("user_id", { count: "exact" })
          .eq("event_id", event.id)
          .limit(24),
        event.createdBy
          ? supabase
              .from("profiles")
              .select("full_name, avatar_url")
              .eq("id", event.createdBy)
              .single()
          : Promise.resolve({ data: null, error: null }),
      ]);

      if (!active) return;
      setRsvpCount(rsvpRes.count ?? 0);

      // Always use the fresh DB name and photo — never trust stale params.
      if (creatorRes.data) {
        const cp = creatorRes.data as any;
        if (cp.full_name) setCreatorDisplayName(cp.full_name);
        setCreatorAvatarUrl(cp.avatar_url ?? null);
      }

      // Batch-fetch attendee profiles to avoid N+1 queries.
      const rsvpRows = rsvpRes.data;
      if (rsvpRows && rsvpRows.length > 0) {
        const { data: profiles } = await supabase
          .from("profiles")
          .select("id, full_name, avatar_url")
          .in("id", rsvpRows.map((r: any) => r.user_id));
        const map: Record<string, { name: string; avatarUrl: string | null }> = {};
        profiles?.forEach((p: any) => {
          map[p.id] = { name: p.full_name ?? "Member", avatarUrl: p.avatar_url ?? null };
        });
        if (active) {
          setAttendees(
            rsvpRows.map((r: any) => ({
              userId: r.user_id,
              name: map[r.user_id]?.name ?? "Member",
              avatarUrl: map[r.user_id]?.avatarUrl ?? undefined,
            }))
          );
        }
      } else {
        if (active) setAttendees([]);
      }
    })();

    return () => { active = false; };
  }, [event.id, event.createdBy]);

  /**
   * RSVP toggle — optimistic update.
   *
   * We update local state immediately so the UI feels instant, then fire the
   * DB write in the background. If the write fails the UI will be inconsistent
   * until the next focus (when data re-fetches). A full rollback on error is a
   * future improvement.
   */
  const toggleRsvp = async () => {
    if (rsvpLoading || !currentUserId) return;
    setRsvpLoading(true);
    try {
      if (hasRsvp) {
        await supabase
          .from("rsvps")
          .delete()
          .eq("event_id", event.id)
          .eq("user_id", currentUserId);
        setHasRsvp(false);
        setRsvpCount((c) => Math.max(0, c - 1));
        setAttendees((prev) => prev.filter((a) => a.userId !== currentUserId));
      } else {
        await supabase
          .from("rsvps")
          .insert({ event_id: event.id, user_id: currentUserId });
        setHasRsvp(true);
        setRsvpCount((c) => c + 1);
        setAttendees((prev) => [{ userId: currentUserId, name: currentUserName }, ...prev]);
      }
    } finally {
      setRsvpLoading(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#000" }} edges={["bottom"]}>
      <ScrollView showsVerticalScrollIndicator={false} bounces>
        {/* ── Banner ── */}
        <View style={{ height: 280, backgroundColor: event.color }}>
          {event.imageUrl ? (
            <Image
              source={{ uri: event.imageUrl }}
              style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
              resizeMode="cover"
            />
          ) : null}

          {/* Layered gradient for title legibility */}
          <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 160, backgroundColor: "rgba(0,0,0,0.10)" }} />
          <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 120, backgroundColor: "rgba(0,0,0,0.22)" }} />
          <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 80,  backgroundColor: "rgba(0,0,0,0.38)" }} />
          <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 48,  backgroundColor: "rgba(0,0,0,0.52)" }} />

          {/* Back button — positioned below Dynamic Island via top inset. */}
          <Pressable
            onPress={() => router.back()}
            style={{
              position: "absolute", top: top + 12, left: 16,
              width: 38, height: 38, borderRadius: 19,
              backgroundColor: "rgba(0,0,0,0.5)",
              alignItems: "center", justifyContent: "center",
            }}
          >
            <Ionicons name="chevron-back" size={22} color="#fff" />
          </Pressable>

          <View style={{ position: "absolute", bottom: 16, left: 18, right: 18 }}>
            {event.hasFreeFood && (
              <View
                style={{
                  flexDirection: "row", alignItems: "center", gap: 4,
                  backgroundColor: "rgba(0,0,0,0.55)",
                  paddingHorizontal: 10, paddingVertical: 4,
                  borderRadius: 999, alignSelf: "flex-start", marginBottom: 8,
                }}
              >
                <Ionicons name="fast-food" size={11} color={ACCENT} />
                <Text style={{ color: ACCENT, fontSize: 11, fontWeight: "700" }}>
                  FREE FOOD
                </Text>
              </View>
            )}
            <Text
              style={{
                color: "#fff", fontSize: 26, fontWeight: "800", letterSpacing: -0.5,
              }}
            >
              {event.title}
            </Text>
          </View>
        </View>

        {/* ── Body ── */}
        <View style={{ padding: 20, gap: 20 }}>
          {/* Organiser row */}
          <View
            style={{
              flexDirection: "row", alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <View
                style={{
                  width: 36, height: 36, borderRadius: 18,
                  backgroundColor: event.color + "33",
                  alignItems: "center", justifyContent: "center",
                }}
              >
                <Text style={{ color: event.color, fontSize: 14, fontWeight: "800" }}>
                  {(event.org || "?").slice(0, 1).toUpperCase()}
                </Text>
              </View>
              <View>
                <Text style={{ color: "#fff", fontWeight: "700", fontSize: 15 }}>
                  {event.org}
                </Text>
                <Text style={{ color: "#666", fontSize: 13 }}>Organizer</Text>
              </View>
            </View>

            <View
              style={{
                flexDirection: "row", alignItems: "center", gap: 5,
                backgroundColor: "#1C1C1E",
                paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
              }}
            >
              <Ionicons name="people" size={14} color={ACCENT} />
              <Text style={{ color: ACCENT, fontSize: 13, fontWeight: "700" }}>
                {rsvpCount} going
              </Text>
            </View>
          </View>

          {/* Posted by — always re-fetched from DB; never relies on stale params. */}
          {event.createdBy && (creatorDisplayName || event.creatorName) && (
            <Pressable
              onPress={() => router.push(`/user/${event.createdBy}`)}
              style={({ pressed }) => ({
                flexDirection: "row", alignItems: "center", gap: 10,
                backgroundColor: pressed ? "#252525" : "#1C1C1E",
                borderRadius: 14,
                paddingHorizontal: 14, paddingVertical: 12,
              })}
            >
              {creatorAvatarUrl ? (
                <Image
                  source={{ uri: creatorAvatarUrl }}
                  style={{ width: 32, height: 32, borderRadius: 16 }}
                />
              ) : (
                <View
                  style={{
                    width: 32, height: 32, borderRadius: 16,
                    backgroundColor: event.color + "33",
                    borderWidth: 1.5, borderColor: event.color + "66",
                    alignItems: "center", justifyContent: "center",
                  }}
                >
                  <Text style={{ color: event.color, fontSize: 13, fontWeight: "800" }}>
                    {(creatorDisplayName || event.creatorName || "?")
                      .trim()
                      .charAt(0)
                      .toUpperCase()}
                  </Text>
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    color: "#555", fontSize: 11, fontWeight: "600", letterSpacing: 0.3,
                  }}
                >
                  POSTED BY
                </Text>
                <Text
                  style={{ color: "#fff", fontSize: 14, fontWeight: "600", marginTop: 1 }}
                >
                  {creatorDisplayName || event.creatorName}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color="#444" />
            </Pressable>
          )}

          <View style={{ height: 1, backgroundColor: "#1C1C1E" }} />

          {/* Date and location */}
          <View style={{ gap: 14 }}>
            {(event.date || event.time) && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                <View
                  style={{
                    width: 36, height: 36, borderRadius: 10,
                    backgroundColor: "#1C1C1E",
                    alignItems: "center", justifyContent: "center",
                  }}
                >
                  <Ionicons name="calendar-outline" size={18} color="#888" />
                </View>
                <View>
                  {event.date && (
                    <Text style={{ color: "#fff", fontSize: 15, fontWeight: "600" }}>
                      {event.date}
                    </Text>
                  )}
                  {event.time && (
                    <Text style={{ color: "#888", fontSize: 13 }}>{event.time}</Text>
                  )}
                </View>
              </View>
            )}

            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <View
                style={{
                  width: 36, height: 36, borderRadius: 10,
                  backgroundColor: "#1C1C1E",
                  alignItems: "center", justifyContent: "center",
                }}
              >
                <Ionicons name="location-outline" size={18} color="#888" />
              </View>
              <Text style={{ color: "#fff", fontSize: 15, fontWeight: "600", flex: 1 }}>
                {event.location}
              </Text>
            </View>
          </View>

          {/* Category chips */}
          {event.categories && event.categories.length > 0 && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {event.categories.map((cat) => {
                const meta = CATEGORY_META[cat] ?? CATEGORY_META.other;
                return (
                  <View
                    key={cat}
                    style={{
                      flexDirection: "row", alignItems: "center", gap: 5,
                      paddingHorizontal: 12, paddingVertical: 6,
                      borderRadius: 999,
                      backgroundColor: meta.color + "22",
                      borderWidth: 1, borderColor: meta.color + "44",
                    }}
                  >
                    <Ionicons name={meta.icon as any} size={13} color={meta.color} />
                    <Text style={{ color: meta.color, fontSize: 13, fontWeight: "600" }}>
                      {meta.label}
                    </Text>
                  </View>
                );
              })}
            </View>
          )}

          {/* ── Who's going ── */}
          {rsvpCount > 0 && (
            <>
              <View style={{ height: 1, backgroundColor: "#1C1C1E" }} />
              <View style={{ gap: 14 }}>
                <Text
                  style={{
                    color: "#888", fontSize: 12, fontWeight: "700", letterSpacing: 0.5,
                  }}
                >
                  {rsvpCount} {rsvpCount === 1 ? "PERSON" : "PEOPLE"} GOING
                </Text>

                <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
                  {attendees.slice(0, 10).map((a) => {
                    const initial = a.name.trim().charAt(0).toUpperCase();
                    const firstName = a.name.split(" ")[0];
                    const hue = avatarColor(a.userId);
                    return (
                      <Pressable
                        key={a.userId}
                        onPress={() => router.push(`/user/${a.userId}`)}
                        style={({ pressed }) => ({
                          alignItems: "center", gap: 5, width: 48,
                          opacity: pressed ? 0.7 : 1,
                        })}
                      >
                        {a.avatarUrl ? (
                          <Image
                            source={{ uri: a.avatarUrl }}
                            style={{ width: 46, height: 46, borderRadius: 23 }}
                          />
                        ) : (
                          <View
                            style={{
                              width: 46, height: 46, borderRadius: 23,
                              backgroundColor: hue + "33",
                              borderWidth: 1.5, borderColor: hue + "66",
                              alignItems: "center", justifyContent: "center",
                            }}
                          >
                            <Text style={{ color: hue, fontSize: 17, fontWeight: "700" }}>
                              {initial}
                            </Text>
                          </View>
                        )}
                        <Text
                          style={{ color: "#666", fontSize: 11 }}
                          numberOfLines={1}
                        >
                          {firstName}
                        </Text>
                      </Pressable>
                    );
                  })}

                  {rsvpCount > 10 && (
                    <View style={{ alignItems: "center", gap: 5, width: 48 }}>
                      <View
                        style={{
                          width: 46, height: 46, borderRadius: 23,
                          backgroundColor: "#2A2A2A",
                          alignItems: "center", justifyContent: "center",
                        }}
                      >
                        <Text
                          style={{ color: "#888", fontSize: 13, fontWeight: "700" }}
                        >
                          +{rsvpCount - 10}
                        </Text>
                      </View>
                      <Text style={{ color: "#666", fontSize: 11 }}>more</Text>
                    </View>
                  )}
                </View>
              </View>
            </>
          )}

          {event.description && (
            <View style={{ height: 1, backgroundColor: "#1C1C1E" }} />
          )}

          {event.description ? (
            <View style={{ gap: 8 }}>
              <Text
                style={{
                  color: "#888", fontSize: 12, fontWeight: "700", letterSpacing: 0.5,
                }}
              >
                ABOUT
              </Text>
              <Text style={{ color: "#ccc", fontSize: 15, lineHeight: 22 }}>
                {event.description}
              </Text>
            </View>
          ) : null}

          {event.coordinates && (
            <Pressable
              onPress={() =>
                openDirections(
                  event.coordinates!.latitude,
                  event.coordinates!.longitude,
                  event.location
                )
              }
              style={({ pressed }) => ({
                backgroundColor: pressed ? "#2C2C2E" : "#1C1C1E",
                borderRadius: 14, paddingVertical: 15,
                flexDirection: "row", alignItems: "center",
                justifyContent: "center", gap: 8,
              })}
            >
              <Ionicons name="navigate-outline" size={17} color="#fff" />
              <Text style={{ color: "#fff", fontWeight: "700", fontSize: 16 }}>
                Get Directions
              </Text>
            </Pressable>
          )}

          {/* Primary action — creator sees Manage, everyone else sees RSVP toggle. */}
          {isCreator ? (
            <Pressable
              onPress={() =>
                router.push({
                  pathname: `/manage/${event.id}`,
                  params: { event: params.event },
                })
              }
              style={({ pressed }) => ({
                backgroundColor: pressed ? "#e0e0e0" : "#fff",
                borderRadius: 14, paddingVertical: 15,
                flexDirection: "row", alignItems: "center",
                justifyContent: "center", gap: 8,
              })}
            >
              <Ionicons name="settings-outline" size={17} color="#000" />
              <Text style={{ color: "#000", fontWeight: "700", fontSize: 16 }}>
                Manage Event
              </Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={toggleRsvp}
              disabled={rsvpLoading}
              style={({ pressed }) => ({
                backgroundColor: hasRsvp
                  ? pressed ? "#1a4a2e" : "#1C3829"
                  : pressed ? event.color + "cc" : event.color,
                borderRadius: 14, paddingVertical: 15,
                flexDirection: "row", alignItems: "center",
                justifyContent: "center", gap: 8,
              })}
            >
              {rsvpLoading ? (
                <ActivityIndicator color="#fff" />
              ) : hasRsvp ? (
                <>
                  <Ionicons name="checkmark-circle" size={17} color="#2BE59A" />
                  <Text style={{ color: "#2BE59A", fontWeight: "700", fontSize: 16 }}>
                    You're Going · Tap to Cancel
                  </Text>
                </>
              ) : (
                <>
                  <Ionicons name="person-add-outline" size={17} color="#fff" />
                  <Text style={{ color: "#fff", fontWeight: "700", fontSize: 16 }}>
                    RSVP to Attend
                  </Text>
                </>
              )}
            </Pressable>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
