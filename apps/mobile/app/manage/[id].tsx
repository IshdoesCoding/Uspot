/**
 * Manage Event screen — creator-only event administration.
 *
 * Access control:
 *  - The screen fetches the event fresh on every focus and verifies that
 *    `event.created_by === currentUser.id` before rendering. If the check
 *    fails the user is sent back immediately.
 *  - Supabase RLS policies are the authoritative security boundary. This
 *    client-side check is defence-in-depth UX only.
 *
 * Features:
 *  - Live attendee count and list (name + relative join time)
 *  - Remove individual attendees (creator cannot remove themselves)
 *  - Permanently delete the event (cascades to RSVPs via DB foreign key)
 *
 * Data flow:
 *  useFocusEffect → fetch event + verify ownership → fetch RSVPs →
 *  batch-fetch profiles for RSVP'd users → render
 *
 * The event snapshot from params is used for the initial title render only.
 * All displayed data comes from the fresh DB fetch to prevent stale-param exploits.
 */

import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Alert,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase, DBProfile } from "../../lib/supabase";
import { ACCENT, DANGER } from "../../lib/constants";
import { timeAgo } from "../../lib/utils";
import { EventItem } from "../components/EventCard";

type Attendee = {
  rsvpId: string;
  userId: string;
  fullName: string;
  joinedAt: string;
};

export default function ManageEvent() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; event: string }>();
  const eventId = params.id;

  // Parse the serialised event snapshot passed from the previous screen.
  // This is used only for the initial title display while fresh data loads.
  // Security: we re-fetch and re-validate ownership from the DB before any
  // destructive action — we never trust params alone.
  let eventSnapshot: EventItem | null = null;
  try {
    eventSnapshot = params.event ? JSON.parse(params.event) : null;
  } catch {
    // Malformed params — proceed with null; fresh fetch will populate state.
  }

  const [event, setEvent] = useState<EventItem | null>(eventSnapshot);
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let active = true;

      const load = async () => {
        setLoading(true);

        const { data: { user } } = await supabase.auth.getUser();
        if (!active) return;
        if (user) setCurrentUserId(user.id);

        // Fetch fresh event data from DB — do NOT rely solely on params.
        const { data: evData, error: evError } = await supabase
          .from("events")
          .select("*")
          .eq("id", eventId)
          .single();

        if (!active) return;

        if (evError || !evData) {
          Alert.alert("Event not found");
          router.back();
          return;
        }

        // Ownership check — redirect if the current user is not the creator.
        if (user && evData.created_by !== user.id) {
          Alert.alert("Unauthorized", "You can only manage your own events.");
          router.back();
          return;
        }

        setEvent({
          id: evData.id,
          title: evData.title,
          org: evData.org,
          location: evData.location,
          color: evData.color,
          time: evData.event_time ?? undefined,
          date: evData.event_date ?? undefined,
          hasFreeFood: evData.has_free_food,
          categories: evData.categories ?? undefined,
          description: evData.description ?? undefined,
          imageUrl: evData.image_url ?? undefined,
          createdBy: evData.created_by ?? undefined,
        });

        // Fetch all RSVPs for this event, newest first.
        const { data: rsvpData } = await supabase
          .from("rsvps")
          .select("id, user_id, created_at")
          .eq("event_id", eventId)
          .order("created_at", { ascending: false });

        if (!active || !rsvpData) { setLoading(false); return; }

        // Batch-fetch display names for all RSVP'd users (avoids N+1 queries).
        const userIds = rsvpData.map((r: any) => r.user_id);
        const profileMap: Record<string, string> = {};
        if (userIds.length > 0) {
          const { data: profiles } = await supabase
            .from("profiles")
            .select("id, full_name")
            .in("id", userIds);
          (profiles as DBProfile[] | null)?.forEach((p) => {
            profileMap[p.id] = p.full_name ?? "Unknown user";
          });
        }

        if (!active) return;
        setAttendees(
          rsvpData.map((r: any) => ({
            rsvpId: r.id,
            userId: r.user_id,
            fullName: profileMap[r.user_id] ?? "Unknown user",
            joinedAt: r.created_at,
          }))
        );
        setLoading(false);
      };

      load();
      return () => { active = false; };
    }, [eventId])
  );

  const removeAttendee = (attendee: Attendee) => {
    Alert.alert(
      "Remove attendee",
      `Remove ${attendee.fullName} from this event?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            // RLS on rsvps also enforces that only the event creator can delete
            // other users' RSVPs via a server-side policy.
            await supabase.from("rsvps").delete().eq("id", attendee.rsvpId);
            setAttendees((prev) => prev.filter((a) => a.rsvpId !== attendee.rsvpId));
          },
        },
      ]
    );
  };

  const deleteEvent = () => {
    Alert.alert(
      "Delete event",
      `"${event?.title}" will be permanently deleted along with all RSVPs. This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete Event",
          style: "destructive",
          onPress: async () => {
            setDeleting(true);
            // RLS ensures only the creator can delete. The .eq("id") filter
            // combined with the RLS policy makes ownership implicit server-side.
            const { error } = await supabase
              .from("events")
              .delete()
              .eq("id", eventId);
            if (error) {
              Alert.alert("Error", error.message);
              setDeleting(false);
            } else {
              router.replace("/profile");
            }
          },
        },
      ]
    );
  };

  const colorBar = event?.color ?? ACCENT;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#000" }}>
      <View
        style={{
          flexDirection: "row", alignItems: "center",
          paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16, gap: 12,
        }}
      >
        <Pressable onPress={() => router.back()} style={{ padding: 4 }}>
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </Pressable>
        <Text
          style={{ flex: 1, color: "#fff", fontSize: 17, fontWeight: "700" }}
          numberOfLines={1}
        >
          {event?.title ?? "Manage Event"}
        </Text>
      </View>

      {/* Colour accent strip matches the event's chosen brand colour. */}
      <View
        style={{
          height: 4,
          backgroundColor: colorBar,
          marginHorizontal: 16,
          borderRadius: 2,
          marginBottom: 20,
        }}
      />

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 48, gap: 24 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Stats row */}
        <View style={{ flexDirection: "row", gap: 10 }}>
          <View
            style={{
              flex: 1, backgroundColor: "#1C1C1E",
              borderRadius: 14, padding: 16,
              alignItems: "center", gap: 4,
            }}
          >
            <Ionicons name="people" size={20} color={ACCENT} />
            <Text style={{ color: "#fff", fontSize: 22, fontWeight: "700" }}>
              {attendees.length}
            </Text>
            <Text style={{ color: "#666", fontSize: 12 }}>Going</Text>
          </View>
          {event?.date && (
            <View
              style={{
                flex: 2, backgroundColor: "#1C1C1E",
                borderRadius: 14, padding: 16,
                justifyContent: "center", gap: 4,
              }}
            >
              <Text style={{ color: "#888", fontSize: 12, fontWeight: "600" }}>
                DATE & TIME
              </Text>
              <Text style={{ color: "#fff", fontSize: 15, fontWeight: "600" }}>
                {event.date}
              </Text>
              {event.time && (
                <Text style={{ color: "#666", fontSize: 13 }}>{event.time}</Text>
              )}
            </View>
          )}
        </View>

        {event?.location && (
          <View
            style={{
              flexDirection: "row", alignItems: "center", gap: 10,
              backgroundColor: "#1C1C1E", borderRadius: 14, padding: 14,
            }}
          >
            <Ionicons name="location-outline" size={18} color="#888" />
            <Text style={{ color: "#fff", fontSize: 14, flex: 1 }}>
              {event.location}
            </Text>
          </View>
        )}

        {/* Attendee list */}
        <View>
          <Text
            style={{
              color: "#555", fontSize: 11, fontWeight: "700",
              letterSpacing: 1, marginBottom: 12,
            }}
          >
            ATTENDEES ({attendees.length})
          </Text>

          {loading ? (
            <View style={{ paddingVertical: 32, alignItems: "center" }}>
              <ActivityIndicator color={ACCENT} />
            </View>
          ) : attendees.length === 0 ? (
            <View
              style={{
                backgroundColor: "#1C1C1E", borderRadius: 16,
                paddingVertical: 32, alignItems: "center", gap: 8,
              }}
            >
              <Ionicons name="people-outline" size={28} color="#333" />
              <Text style={{ color: "#555", fontSize: 14 }}>No RSVPs yet</Text>
            </View>
          ) : (
            <View
              style={{ backgroundColor: "#1C1C1E", borderRadius: 16, overflow: "hidden" }}
            >
              {attendees.map((a, idx) => (
                <View key={a.rsvpId}>
                  {idx > 0 && (
                    <View
                      style={{
                        height: 1,
                        backgroundColor: "#2A2A2A",
                        marginLeft: 54,
                      }}
                    />
                  )}
                  <View
                    style={{
                      flexDirection: "row", alignItems: "center",
                      paddingHorizontal: 14, paddingVertical: 13, gap: 12,
                    }}
                  >
                    <View
                      style={{
                        width: 36, height: 36, borderRadius: 18,
                        backgroundColor: colorBar + "33",
                        alignItems: "center", justifyContent: "center",
                      }}
                    >
                      <Text style={{ color: colorBar, fontSize: 14, fontWeight: "700" }}>
                        {a.fullName.trim().charAt(0).toUpperCase()}
                      </Text>
                    </View>

                    <View style={{ flex: 1 }}>
                      <Text style={{ color: "#fff", fontSize: 14, fontWeight: "600" }}>
                        {a.fullName}
                      </Text>
                      <Text style={{ color: "#555", fontSize: 12 }}>
                        Joined {timeAgo(a.joinedAt)}
                      </Text>
                    </View>

                    {/* Prevent the creator from accidentally removing themselves. */}
                    {a.userId !== currentUserId && (
                      <Pressable
                        onPress={() => removeAttendee(a)}
                        style={({ pressed }) => ({
                          paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
                          backgroundColor: pressed ? "#3A1A1A" : "#2A1A1A",
                        })}
                      >
                        <Text
                          style={{ color: DANGER, fontSize: 13, fontWeight: "600" }}
                        >
                          Remove
                        </Text>
                      </Pressable>
                    )}
                  </View>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* Danger zone */}
        <View>
          <Text
            style={{
              color: "#555", fontSize: 11, fontWeight: "700",
              letterSpacing: 1, marginBottom: 12,
            }}
          >
            DANGER ZONE
          </Text>
          <Pressable
            onPress={deleteEvent}
            disabled={deleting}
            style={({ pressed }) => ({
              flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
              backgroundColor: pressed ? "#3A1A1A" : "#1C1C1E",
              borderRadius: 14, paddingVertical: 16,
              borderWidth: 1, borderColor: DANGER + "33",
            })}
          >
            {deleting ? (
              <ActivityIndicator color={DANGER} />
            ) : (
              <>
                <Ionicons name="trash-outline" size={17} color={DANGER} />
                <Text style={{ color: DANGER, fontWeight: "700", fontSize: 16 }}>
                  Delete Event
                </Text>
              </>
            )}
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
