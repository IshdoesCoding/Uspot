/**
 * EventCard — the primary event list item used across all feed and profile views.
 *
 * This is the single canonical card component. All screens (EventScreen feed,
 * profile My Events, profile Joined Events, user profile) render this same
 * component from the same EventItem data shape. This prevents the visual and
 * data drift that previously existed when profile used a separate AdminEventCard.
 *
 * Layout:
 *  ┌─────────────────────────────────────────┐
 *  │  Banner (colour fill or event photo)    │
 *  │  [FREE FOOD badge]        [⋯ menu]      │
 *  │                       Event Title       │
 *  ├─────────────────────────────────────────┤
 *  │  [Org avatar]  Org name      N going    │
 *  │  📍 Location                 🕐 Time    │
 *  └─────────────────────────────────────────┘
 */

import React from "react";
import { View, Text, Pressable, Image, Share, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";

/** Shape consumed by EventCard and passed as the `event` param to /event/[id]. */
export type EventItem = {
  id: string;
  title: string;
  /** Club or organisation that posted the event. Shown in card and detail. */
  org: string;
  location: string;
  /** Hex accent colour chosen by the creator; used as banner background. */
  color: string;
  time?: string;
  date?: string;
  hasFreeFood?: boolean;
  categories?: string[];
  coordinates?: { latitude: number; longitude: number };
  description?: string;
  /** Public URL of the banner image in the event-images Storage bucket. */
  imageUrl?: string;
  /** Auth user ID of the creator. Used to navigate to /user/[id]. */
  createdBy?: string;
  /** Display name of the creator — batch-fetched from profiles by callers. */
  creatorName?: string;
  /** Pre-computed RSVP count. Shown in the card footer. */
  rsvpCount?: number;
};

export default function EventCard({
  item,
  onPress,
}: {
  item: EventItem;
  onPress?: () => void;
}) {
  const count = item.rsvpCount ?? 0;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        borderRadius: 20,
        overflow: "hidden",
        backgroundColor: "#111",
        opacity: pressed ? 0.92 : 1,
      })}
    >
      {/* ── Banner ── */}
      <View style={{ height: 172, backgroundColor: item.color }}>
        {item.imageUrl ? (
          <Image
            source={{ uri: item.imageUrl }}
            style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
            resizeMode="cover"
          />
        ) : null}

        {/* Layered gradient via stacked semi-transparent views — avoids expo-linear-gradient dep. */}
        <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 120, backgroundColor: "rgba(0,0,0,0.08)" }} />
        <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 90,  backgroundColor: "rgba(0,0,0,0.18)" }} />
        <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 65,  backgroundColor: "rgba(0,0,0,0.30)" }} />
        <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 44,  backgroundColor: "rgba(0,0,0,0.42)" }} />

        {/* Top row: free food badge + contextual action menu */}
        <View
          style={{
            position: "absolute",
            top: 12, left: 12, right: 12,
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          {item.hasFreeFood ? (
            <View
              style={{
                flexDirection: "row", alignItems: "center", gap: 4,
                backgroundColor: "rgba(0,0,0,0.55)",
                paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999,
              }}
            >
              <Ionicons name="fast-food" size={11} color="#F7931A" />
              <Text style={{ color: "#F7931A", fontSize: 11, fontWeight: "700", letterSpacing: 0.3 }}>
                FREE FOOD
              </Text>
            </View>
          ) : (
            <View />
          )}

          {/* ⋯ menu — share or report. stopPropagation prevents triggering the card press. */}
          <Pressable
            onPress={(e) => {
              e.stopPropagation();
              Alert.alert(item.title, undefined, [
                {
                  text: "Share Event",
                  onPress: () =>
                    Share.share({
                      message: `Check out "${item.title}" at ${item.location}${
                        item.time ? ` — ${item.time}` : ""
                      }`,
                    }),
                },
                {
                  text: "Report",
                  style: "destructive",
                  onPress: () =>
                    Alert.alert("Reported", "Thanks for letting us know."),
                },
                { text: "Cancel", style: "cancel" },
              ]);
            }}
            style={{
              width: 30, height: 30, borderRadius: 15,
              backgroundColor: "rgba(0,0,0,0.45)",
              alignItems: "center", justifyContent: "center",
            }}
          >
            <Ionicons name="ellipsis-horizontal" size={14} color="rgba(255,255,255,0.85)" />
          </Pressable>
        </View>

        {/* Title sits at the bottom of the banner over the gradient. */}
        <View style={{ position: "absolute", bottom: 11, left: 13, right: 13 }}>
          <Text
            style={{ color: "#fff", fontSize: 18, fontWeight: "800", letterSpacing: -0.3 }}
            numberOfLines={2}
          >
            {item.title}
          </Text>
        </View>
      </View>

      {/* ── Org row + RSVP count ── */}
      <View
        style={{
          flexDirection: "row", alignItems: "center",
          paddingHorizontal: 13, paddingTop: 11, paddingBottom: 8,
          backgroundColor: "#111", gap: 8,
        }}
      >
        <View
          style={{
            width: 20, height: 20, borderRadius: 10,
            backgroundColor: item.color + "33",
            alignItems: "center", justifyContent: "center",
          }}
        >
          <Text style={{ color: item.color, fontSize: 9, fontWeight: "800" }}>
            {item.org.slice(0, 1).toUpperCase()}
          </Text>
        </View>
        <Text
          style={{ color: "#888", fontSize: 13, fontWeight: "500", flex: 1 }}
          numberOfLines={1}
        >
          {item.org}
        </Text>
        {count > 0 && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Ionicons name="people" size={13} color="#555" />
            <Text style={{ color: "#666", fontSize: 12, fontWeight: "600" }}>{count}</Text>
          </View>
        )}
      </View>

      {/* ── Location + time ── */}
      <View
        style={{
          flexDirection: "row", alignItems: "center",
          paddingHorizontal: 13, paddingBottom: 12, gap: 14,
          backgroundColor: "#111",
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flex: 1, minWidth: 0 }}>
          <Ionicons name="location-outline" size={12} color="#555" />
          <Text style={{ color: "#555", fontSize: 12 }} numberOfLines={1}>
            {item.location}
          </Text>
        </View>
        {item.time && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Ionicons name="time-outline" size={12} color="#555" />
            <Text style={{ color: "#555", fontSize: 12 }}>{item.time}</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}
