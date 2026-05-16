/**
 * Public user profile screen — `/user/[id]`
 *
 * Shown when a user taps "Posted by" on an event detail or taps an attendee
 * avatar in the "Who's going" section.
 *
 * Data fetched on mount:
 *  - Profile row: full_name, class_year, major, bio, avatar_url
 *  - All events created by this user (select * for full EventItem data)
 *
 * Edge cases:
 *  - `isOwnProfile` is true when the viewer is looking at their own public
 *    profile — an "Edit" button appears that routes to the profile edit screen.
 *  - If the profile row doesn't exist (e.g. trigger didn't fire on signup),
 *    we fall back to "UVA Student" as the display name.
 *
 * Security:
 *  - Profiles are publicly readable (RLS policy: FOR SELECT USING (true)).
 *  - Events are publicly readable. No sensitive data is exposed here.
 */

import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase, DBEvent } from "../../lib/supabase";
import { ACCENT } from "../../lib/constants";
import { avatarColor, toEventItem } from "../../lib/utils";
import EventCard, { EventItem } from "../components/EventCard";

export default function UserProfile() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [profile, setProfile] = useState<{
    full_name: string | null;
    class_year: string | null;
    major: string | null;
    bio: string | null;
    avatar_url: string | null;
  } | null>(null);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [isOwnProfile, setIsOwnProfile] = useState(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (active) setIsOwnProfile(user?.id === id);

      const [profileRes, eventsRes] = await Promise.all([
        supabase
          .from("profiles")
          .select("full_name, class_year, major, bio, avatar_url")
          .eq("id", id)
          .single(),
        supabase
          .from("events")
          .select("*")
          .eq("created_by", id)
          .order("created_at", { ascending: false }),
      ]);

      if (!active) return;
      if (profileRes.data) setProfile(profileRes.data as any);
      if (!eventsRes.error && eventsRes.data) {
        setEvents((eventsRes.data as DBEvent[]).map((row) => toEventItem(row)));
      }
      setLoading(false);
    };
    load();
    return () => { active = false; };
  }, [id]);

  const name = profile?.full_name ?? "UVA Student";
  const initial = name.trim().charAt(0).toUpperCase();
  const color = avatarColor(id);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#000" }}>
      {/* Header */}
      <View
        style={{
          flexDirection: "row", alignItems: "center",
          paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16, gap: 12,
        }}
      >
        <Pressable onPress={() => router.back()} style={{ padding: 4 }}>
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </Pressable>
        <Text style={{ color: "#fff", fontSize: 17, fontWeight: "700", flex: 1 }}>
          Profile
        </Text>
        {isOwnProfile && (
          <Pressable onPress={() => router.replace("/profile")}>
            <Text style={{ color: ACCENT, fontSize: 15, fontWeight: "600" }}>Edit</Text>
          </Pressable>
        )}
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={ACCENT} size="large" />
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 48 }}
        >
          {/* ── Profile card ── */}
          <View
            style={{
              alignItems: "center",
              paddingTop: 20, paddingBottom: 32, paddingHorizontal: 24,
              gap: 10,
            }}
          >
            {/* Avatar — real photo if available, else colour initial */}
            {profile?.avatar_url ? (
              <Image
                source={{ uri: profile.avatar_url }}
                style={{
                  width: 88, height: 88, borderRadius: 44,
                  borderWidth: 2.5, borderColor: color + "77",
                }}
              />
            ) : (
              <View
                style={{
                  width: 88, height: 88, borderRadius: 44,
                  backgroundColor: color + "28",
                  borderWidth: 2.5, borderColor: color + "77",
                  alignItems: "center", justifyContent: "center",
                }}
              >
                <Text style={{ color, fontSize: 34, fontWeight: "700" }}>
                  {initial}
                </Text>
              </View>
            )}

            <Text
              style={{ color: "#fff", fontSize: 22, fontWeight: "700", marginTop: 4 }}
            >
              {name}
            </Text>

            {(profile?.class_year || profile?.major) && (
              <Text style={{ color: "#666", fontSize: 14, textAlign: "center" }}>
                {[profile.class_year, profile.major].filter(Boolean).join(" · ")}
              </Text>
            )}

            <View
              style={{
                flexDirection: "row", alignItems: "center", gap: 6,
                backgroundColor: "#1C1C1E",
                paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999,
                marginTop: 4,
              }}
            >
              <Ionicons name="school-outline" size={14} color="#555" />
              <Text style={{ color: "#666", fontSize: 13 }}>
                University of Virginia
              </Text>
            </View>

            {profile?.bio ? (
              <Text
                style={{
                  color: "#888", fontSize: 13, textAlign: "center",
                  marginHorizontal: 8, lineHeight: 18,
                }}
              >
                {profile.bio}
              </Text>
            ) : null}
          </View>

          <View
            style={{
              height: 1,
              backgroundColor: "#1C1C1E",
              marginHorizontal: 16,
              marginBottom: 24,
            }}
          />

          {/* ── Created events ── */}
          <View style={{ paddingHorizontal: 16 }}>
            <Text
              style={{
                color: "#555", fontSize: 11, fontWeight: "700",
                letterSpacing: 1, marginBottom: 12,
              }}
            >
              EVENTS CREATED · {events.length}
            </Text>

            {events.length === 0 ? (
              <View
                style={{
                  backgroundColor: "#1C1C1E", borderRadius: 16,
                  paddingVertical: 32, alignItems: "center", gap: 8,
                }}
              >
                <Ionicons name="calendar-outline" size={26} color="#333" />
                <Text style={{ color: "#555", fontSize: 14 }}>
                  No events posted yet
                </Text>
              </View>
            ) : (
              <View style={{ gap: 10 }}>
                {events.map((item) => (
                  <EventCard
                    key={item.id}
                    item={item}
                    onPress={() =>
                      router.push({
                        pathname: `/event/${item.id}`,
                        params: { event: JSON.stringify(item) },
                      })
                    }
                  />
                ))}
              </View>
            )}
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
