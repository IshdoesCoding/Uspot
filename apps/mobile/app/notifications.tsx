/**
 * Notifications inbox screen.
 *
 * Data flow:
 *  1. On focus, fetch the latest 50 notifications for the current user,
 *     ordered newest-first.
 *  2. Immediately fire a background update to mark all fetched notifications
 *     as read (fire-and-forget — UI doesn't wait for this to complete).
 *  3. The notification bell badge in EventScreen reads the unread count
 *     separately on its own focus cycle, so clearing here will zero the
 *     badge on the user's next visit to the feed.
 *
 * Notification types:
 *  - rsvp     — someone RSVPd to one of the user's events (written by DB trigger)
 *  - reminder — future use (event starting soon)
 *  - update   — future use (event details changed)
 *
 * Security:
 *  - Supabase RLS on the notifications table ensures users can only read
 *    their own rows (WHERE user_id = auth.uid()).
 *  - The clearAll operation deletes only rows for the authenticated user.
 */

import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  Pressable,
  FlatList,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { supabase, DBNotification } from "../lib/supabase";
import { ACCENT } from "../lib/constants";
import { timeAgo } from "../lib/utils";

/** Icon and colour for each notification type. */
const TYPE_META: Record<DBNotification["type"], { icon: string; color: string }> = {
  rsvp:     { icon: "person-add",         color: "#2B6FE5" },
  reminder: { icon: "time",               color: ACCENT    },
  update:   { icon: "information-circle", color: "#B12BE5" },
};

export default function Notifications() {
  const router = useRouter();
  const [notifications, setNotifications] = useState<DBNotification[]>([]);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let active = true;

      const load = async () => {
        setLoading(true);
        const { data: { user } } = await supabase.auth.getUser();
        if (!active || !user) { setLoading(false); return; }

        const { data } = await supabase
          .from("notifications")
          .select("*")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(50);

        if (!active) return;
        if (data) setNotifications(data as DBNotification[]);
        setLoading(false);

        // Mark all unread as read in the background; the badge in EventScreen
        // will reflect 0 on its next focus cycle.
        supabase
          .from("notifications")
          .update({ read: true })
          .eq("user_id", user.id)
          .eq("read", false)
          .then(() => {});
      };

      load();
      return () => { active = false; };
    }, [])
  );

  const clearAll = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from("notifications").delete().eq("user_id", user.id);
    setNotifications([]);
  };

  const renderItem = ({ item }: { item: DBNotification }) => {
    const meta = TYPE_META[item.type] ?? TYPE_META.update;
    return (
      <Pressable
        onPress={() => {
          // TODO: when a full event-lookup endpoint is available, navigate to
          // /event/[item.event_id]. Currently requires serialised EventItem JSON
          // which isn't available here without a full DB fetch.
        }}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "flex-start",
          paddingHorizontal: 16,
          paddingVertical: 14,
          gap: 12,
          // Unread rows get a subtle blue tint to draw attention.
          backgroundColor: pressed ? "#181818" : item.read ? "transparent" : "#0D1A2E",
        })}
      >
        <View
          style={{
            width: 38, height: 38, borderRadius: 19,
            backgroundColor: meta.color + "22",
            alignItems: "center", justifyContent: "center",
            marginTop: 1,
          }}
        >
          <Ionicons name={meta.icon as any} size={17} color={meta.color} />
        </View>

        <View style={{ flex: 1, gap: 3 }}>
          <Text
            style={{
              color: "#fff",
              fontSize: 14,
              // Unread notifications are bold to indicate new content.
              fontWeight: item.read ? "500" : "700",
            }}
          >
            {item.title}
          </Text>
          <Text style={{ color: "#888", fontSize: 13, lineHeight: 18 }}>
            {item.body}
          </Text>
          <Text style={{ color: "#555", fontSize: 12, marginTop: 2 }}>
            {timeAgo(item.created_at)}
          </Text>
        </View>

        {/* Unread indicator dot */}
        {!item.read && (
          <View
            style={{
              width: 8, height: 8, borderRadius: 4,
              backgroundColor: meta.color,
              marginTop: 6,
            }}
          />
        )}
      </Pressable>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#000" }}>
      <View
        style={{
          flexDirection: "row", alignItems: "center", justifyContent: "space-between",
          paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Pressable onPress={() => router.back()} style={{ padding: 4 }}>
            <Ionicons name="chevron-back" size={22} color="#fff" />
          </Pressable>
          <Text style={{ color: "#fff", fontSize: 20, fontWeight: "700" }}>
            Notifications
          </Text>
        </View>
        {notifications.length > 0 && (
          <Pressable onPress={clearAll} style={{ padding: 4 }}>
            <Text style={{ color: "#555", fontSize: 14 }}>Clear all</Text>
          </Pressable>
        )}
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={ACCENT} size="large" />
        </View>
      ) : notifications.length === 0 ? (
        <View
          style={{
            flex: 1, alignItems: "center", justifyContent: "center", gap: 12,
          }}
        >
          <View
            style={{
              width: 64, height: 64, borderRadius: 32,
              backgroundColor: "#1C1C1E",
              alignItems: "center", justifyContent: "center",
            }}
          >
            <Ionicons name="notifications-off-outline" size={28} color="#444" />
          </View>
          <Text style={{ color: "#fff", fontSize: 16, fontWeight: "600" }}>
            All caught up
          </Text>
          <Text style={{ color: "#555", fontSize: 14 }}>No notifications yet</Text>
        </View>
      ) : (
        <FlatList
          data={notifications}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          showsVerticalScrollIndicator={false}
          ItemSeparatorComponent={() => (
            <View
              style={{
                height: 1,
                backgroundColor: "#1C1C1E",
                marginLeft: 66,
              }}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}
