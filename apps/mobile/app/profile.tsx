/**
 * Profile screen — `/profile` (tab 4)
 *
 * Responsibilities:
 *  1. Display the signed-in user's profile (name, class year, major, bio, avatar).
 *  2. Inline edit mode: tap "Edit" to mutate draft state; "Save" persists to DB.
 *  3. Avatar upload: picks from library → uploads to Supabase Storage `avatars`
 *     bucket under `{userId}/avatar.jpg` with upsert; cache-busts the URL with
 *     `?t=<timestamp>` so the Image component doesn't serve a stale CDN response.
 *  4. Aggregated stats: events created, events joined (RSVP'd).
 *  5. Listings: "My Events" (with a Manage shortcut) and "Joined Events".
 *  6. Settings: notification toggle, help, about, sign-out.
 *
 * Data flow (useFocusEffect fires on every tab focus to stay fresh):
 *  supabase.auth.getUser()
 *   → parallel: profiles row, created events, all rsvps (for count map),
 *               joined events via rsvps JOIN events
 *   → build RSVP count map (event_id → attendee count) for StatPill
 *   → map DB rows → EventItem via shared toEventItem() util
 *
 * Edit mode state:
 *  Committed: name / classYear / major / bio / avatarUrl (shown in view mode)
 *  Draft:     draftName / draftYear / draftMajor / draftBio / draftAvatarUrl
 *  On cancel: drafts are discarded, committed values stay unchanged.
 *  On save:   drafts are pushed to DB; on success, committed values are updated.
 *  This two-buffer approach keeps the UI snappy — a failed save never corrupts
 *  the visible profile because we only flush committed state on success.
 *
 * Avatar size guard:
 *  We check asset.fileSize against MAX_AVATAR_BYTES (5 MB) before uploading.
 *  expo-image-picker does not guarantee fileSize is populated on all platforms,
 *  so we treat a missing fileSize as acceptable and let Supabase enforce limits
 *  server-side via its bucket upload-size policy.
 *
 * Security:
 *  - Supabase RLS: profiles are only writeable by the owner
 *    (policy: FOR UPDATE USING (auth.uid() = id)).
 *  - We send `supabase.auth.getUser()` (verified server-side JWT) not
 *    `supabase.auth.getSession()` (client cache) before any mutation.
 */

import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Switch,
  Alert,
  TextInput,
  ActivityIndicator,
  Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import BottomNav from "./components/BottomNav";
import EventCard, { EventItem } from "./components/EventCard";
import { supabase, DBEvent } from "../lib/supabase";
import { ACCENT } from "../lib/constants";
import { avatarColor, toEventItem, MAX_AVATAR_BYTES } from "../lib/utils";

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <View
      style={{
        flexDirection: "row", alignItems: "center", justifyContent: "space-between",
        marginHorizontal: 16, marginTop: 28, marginBottom: 10,
      }}
    >
      <Text style={{ color: "#555", fontSize: 11, fontWeight: "700", letterSpacing: 1 }}>
        {title}
      </Text>
      {action}
    </View>
  );
}

function SettingRow({
  icon, label, danger, rightElement, onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  danger?: boolean;
  rightElement?: React.ReactNode;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row", alignItems: "center",
        paddingHorizontal: 16, paddingVertical: 14,
        backgroundColor: pressed ? "#252525" : "transparent", gap: 14,
      })}
    >
      <Ionicons name={icon} size={20} color={danger ? "#E5403A" : "#888"} />
      <Text style={{ flex: 1, color: danger ? "#E5403A" : "#fff", fontSize: 15 }}>{label}</Text>
      {rightElement ?? <Ionicons name="chevron-forward" size={16} color="#444" />}
    </Pressable>
  );
}

function RowSeparator() {
  return <View style={{ height: 1, backgroundColor: "#222", marginLeft: 50 }} />;
}

function StatPill({ icon, value, label, color }: { icon: string; value: string | number; label: string; color: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center", gap: 4, paddingVertical: 14, backgroundColor: "#1C1C1E", borderRadius: 14 }}>
      <Ionicons name={icon as any} size={18} color={color} />
      <Text style={{ color: "#fff", fontSize: 18, fontWeight: "700" }}>{value}</Text>
      <Text style={{ color: "#666", fontSize: 12 }}>{label}</Text>
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function Profile() {
  const router = useRouter();

  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Committed profile state — what the user last saved or fetched from DB.
  const [userId, setUserId] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [name, setName] = useState("UVA Student");
  const [classYear, setClassYear] = useState("");
  const [major, setMajor] = useState("");
  const [bio, setBio] = useState("");

  // Draft state — mutated during edit mode, flushed to committed on save.
  const [draftName, setDraftName] = useState("");
  const [draftYear, setDraftYear] = useState("");
  const [draftMajor, setDraftMajor] = useState("");
  const [draftBio, setDraftBio] = useState("");
  const [draftAvatarUrl, setDraftAvatarUrl] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  const [myEvents, setMyEvents] = useState<EventItem[]>([]);
  const [joinedEvents, setJoinedEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let active = true;

      const load = async () => {
        setLoading(true);
        const { data: { user } } = await supabase.auth.getUser();
        if (!active || !user) { setLoading(false); return; }

        setUserId(user.id);

        // Four parallel queries: profile, created events, all RSVPs (for count
        // map), and joined events via the rsvps→events foreign-key join.
        const [profileRes, eventsRes, rsvpsRes, joinedRes] = await Promise.all([
          supabase
            .from("profiles")
            .select("full_name, class_year, major, bio, avatar_url")
            .eq("id", user.id)
            .single(),
          supabase
            .from("events")
            .select("*")
            .eq("created_by", user.id)
            .order("created_at", { ascending: false }),
          // Fetch all RSVPs (not just the user's) to build a per-event count
          // map without firing N individual count queries.
          supabase.from("rsvps").select("event_id"),
          supabase
            .from("rsvps")
            .select("event_id, events(*)")
            .eq("user_id", user.id)
            .order("created_at", { ascending: false }),
        ]);

        if (!active) return;

        if (profileRes.data) {
          const p = profileRes.data as any;
          setName(p.full_name ?? "UVA Student");
          setClassYear(p.class_year ?? "");
          setMajor(p.major ?? "");
          setBio(p.bio ?? "");
          setAvatarUrl(p.avatar_url ?? null);
        }

        // Build event_id → count map in O(n) to avoid N+1 count queries.
        const countMap: Record<string, number> = {};
        rsvpsRes.data?.forEach((r: any) => {
          countMap[r.event_id] = (countMap[r.event_id] ?? 0) + 1;
        });

        if (!eventsRes.error && eventsRes.data) {
          setMyEvents(
            (eventsRes.data as DBEvent[]).map((row) =>
              toEventItem(row, countMap[row.id] ?? 0)
            )
          );
        }

        if (!joinedRes.error && joinedRes.data) {
          const joined = joinedRes.data
            .map((r: any) => r.events)
            .filter(Boolean) as DBEvent[];
          setJoinedEvents(joined.map((row) => toEventItem(row, countMap[row.id] ?? 0)));
        }

        setLoading(false);
      };

      load();
      return () => { active = false; };
    }, [])
  );

  // Seed drafts from committed state so edits start from the current values.
  const startEditing = () => {
    setDraftName(name);
    setDraftYear(classYear);
    setDraftMajor(major);
    setDraftBio(bio);
    setDraftAvatarUrl(avatarUrl);
    setIsEditing(true);
  };

  const cancelEdits = () => {
    setDraftAvatarUrl(null);
    setIsEditing(false);
  };

  const saveEdits = async () => {
    if (!draftName.trim()) { Alert.alert("Name can't be empty."); return; }
    if (!userId) return;
    setSaving(true);

    const updates: Record<string, string | null> = {
      full_name: draftName.trim(),
      class_year: draftYear.trim() || null,
      major: draftMajor.trim() || null,
      bio: draftBio.trim() || null,
    };

    // Only include avatar_url if the user actually changed it — avoids
    // overwriting a previously saved URL with the same value.
    if (draftAvatarUrl && draftAvatarUrl !== avatarUrl) {
      updates.avatar_url = draftAvatarUrl;
    }

    const { error } = await supabase.from("profiles").update(updates).eq("id", userId);
    setSaving(false);

    if (error) {
      Alert.alert("Error", "Could not save profile. Please try again.");
      return;
    }

    // Flush drafts to committed state only after a successful DB write.
    setName(draftName.trim());
    setClassYear(draftYear.trim());
    setMajor(draftMajor.trim());
    setBio(draftBio.trim());
    if (draftAvatarUrl && draftAvatarUrl !== avatarUrl) setAvatarUrl(draftAvatarUrl);
    setIsEditing(false);
  };

  const pickAvatar = async () => {
    if (!userId) return;
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Allow photo access to upload a profile picture.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (result.canceled || !result.assets[0]) return;

    const asset = result.assets[0];

    // Guard against large files before uploading. fileSize may be undefined on
    // some platforms — in that case we skip the check and let Supabase enforce
    // its bucket size policy server-side.
    if (asset.fileSize && asset.fileSize > MAX_AVATAR_BYTES) {
      Alert.alert("Image too large", "Please choose a photo smaller than 5 MB.");
      return;
    }

    setUploadingAvatar(true);
    const path = `${userId}/avatar.jpg`;

    const formData = new FormData();
    formData.append("file", {
      uri: asset.uri,
      name: "avatar.jpg",
      type: "image/jpeg",
    } as any);

    const { error } = await supabase.storage
      .from("avatars")
      .upload(path, formData, { upsert: true, contentType: "image/jpeg" });

    setUploadingAvatar(false);

    if (error) {
      Alert.alert("Upload failed", "Could not upload photo. Make sure the avatars bucket exists in Supabase Storage.");
      return;
    }

    const { data } = supabase.storage.from("avatars").getPublicUrl(path);
    // Append a timestamp query param to force-invalidate the CDN cache for this
    // URL — without it the Image component returns the old cached photo.
    const url = `${data.publicUrl}?t=${Date.now()}`;
    setDraftAvatarUrl(url);
  };

  const openEventDetail = (item: EventItem) => {
    router.push({
      pathname: `/event/${item.id}`,
      params: { event: JSON.stringify(item) },
    });
  };

  const color = userId ? avatarColor(userId) : ACCENT;
  const initial = name.trim().charAt(0).toUpperCase();
  // In edit mode show the draft avatar so changes are immediately visible.
  const displayAvatar = isEditing ? draftAvatarUrl : avatarUrl;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#000" }}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 110 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Top bar ── */}
        <View
          style={{
            paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4,
            flexDirection: "row", alignItems: "center", justifyContent: "space-between",
          }}
        >
          <Text style={{ color: "#fff", fontSize: 22, fontWeight: "700" }}>Profile</Text>
          {isEditing ? (
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Pressable
                onPress={cancelEdits}
                style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: "#1C1C1E" }}
              >
                <Text style={{ color: "#888", fontSize: 13, fontWeight: "600" }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={saveEdits}
                disabled={saving}
                style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: "#fff" }}
              >
                {saving
                  ? <ActivityIndicator size="small" color="#000" />
                  : <Text style={{ color: "#000", fontSize: 13, fontWeight: "700" }}>Save</Text>}
              </Pressable>
            </View>
          ) : (
            <Pressable
              onPress={startEditing}
              style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: "#1C1C1E" }}
            >
              <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600" }}>Edit</Text>
            </Pressable>
          )}
        </View>

        {/* ── Avatar + identity ── */}
        <View style={{ alignItems: "center", paddingTop: 28, paddingBottom: 20 }}>
          <Pressable onPress={isEditing ? pickAvatar : undefined} style={{ position: "relative" }}>
            {displayAvatar ? (
              <Image
                source={{ uri: displayAvatar }}
                style={{ width: 96, height: 96, borderRadius: 48, borderWidth: 2.5, borderColor: color + "88" }}
              />
            ) : (
              <View
                style={{
                  width: 96, height: 96, borderRadius: 48,
                  backgroundColor: color + "28",
                  borderWidth: 2.5, borderColor: color + "77",
                  alignItems: "center", justifyContent: "center",
                }}
              >
                <Text style={{ color, fontSize: 36, fontWeight: "700" }}>{initial}</Text>
              </View>
            )}
            {isEditing && (
              <View
                style={{
                  position: "absolute", bottom: 0, right: 0,
                  width: 30, height: 30, borderRadius: 15,
                  backgroundColor: "#1C1C1E", borderWidth: 2, borderColor: "#000",
                  alignItems: "center", justifyContent: "center",
                }}
              >
                {uploadingAvatar
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Ionicons name="camera-outline" size={15} color="#fff" />}
              </View>
            )}
          </Pressable>

          {loading ? (
            <ActivityIndicator color={ACCENT} style={{ marginTop: 20 }} />
          ) : isEditing ? (
            <View style={{ width: "80%", marginTop: 18, gap: 10 }}>
              <TextInput
                value={draftName}
                onChangeText={setDraftName}
                placeholder="Full name"
                placeholderTextColor="#444"
                style={{
                  color: "#fff", fontSize: 18, fontWeight: "700",
                  backgroundColor: "#1C1C1E", borderRadius: 12,
                  paddingHorizontal: 14, paddingVertical: 10, textAlign: "center",
                }}
              />
              <TextInput
                value={draftYear}
                onChangeText={setDraftYear}
                placeholder="Class of 20XX"
                placeholderTextColor="#444"
                style={{
                  color: "#aaa", fontSize: 14, backgroundColor: "#1C1C1E",
                  borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8, textAlign: "center",
                }}
              />
              <TextInput
                value={draftMajor}
                onChangeText={setDraftMajor}
                placeholder="Major"
                placeholderTextColor="#444"
                style={{
                  color: "#aaa", fontSize: 14, backgroundColor: "#1C1C1E",
                  borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8, textAlign: "center",
                }}
              />
              <TextInput
                value={draftBio}
                onChangeText={setDraftBio}
                placeholder="Bio (optional)"
                placeholderTextColor="#444"
                multiline
                numberOfLines={3}
                style={{
                  color: "#ccc", fontSize: 13, backgroundColor: "#1C1C1E",
                  borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10,
                  textAlign: "center", minHeight: 72,
                }}
              />
            </View>
          ) : (
            <View style={{ alignItems: "center", marginTop: 14, gap: 4 }}>
              <Text style={{ color: "#fff", fontSize: 22, fontWeight: "700" }}>{name}</Text>
              {(classYear || major) ? (
                <Text style={{ color: "#666", fontSize: 14 }}>
                  {[classYear, major].filter(Boolean).join(" · ")}
                </Text>
              ) : null}
              <View
                style={{
                  flexDirection: "row", alignItems: "center", gap: 6,
                  backgroundColor: "#1C1C1E",
                  paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999, marginTop: 4,
                }}
              >
                <Ionicons name="school-outline" size={13} color="#555" />
                <Text style={{ color: "#555", fontSize: 13 }}>University of Virginia</Text>
              </View>
              {bio ? (
                <Text style={{ color: "#888", fontSize: 13, marginTop: 6, textAlign: "center", marginHorizontal: 32, lineHeight: 18 }}>
                  {bio}
                </Text>
              ) : null}
            </View>
          )}
        </View>

        {/* ── Stats row ── */}
        <View style={{ flexDirection: "row", gap: 10, marginHorizontal: 16, marginTop: 8 }}>
          <StatPill icon="calendar-outline"  value={myEvents.length}     label="Created" color={ACCENT}   />
          <StatPill icon="people-outline"    value={joinedEvents.length} label="Going"   color="#2B6FE5"  />
          <StatPill icon="bookmark-outline"  value={0}                   label="Saved"   color="#2BE59A"  />
        </View>

        {/* ── My Events ── */}
        <SectionHeader
          title="MY EVENTS"
          action={
            <Pressable
              onPress={() => router.push("/CreateEvent")}
              style={{
                flexDirection: "row", alignItems: "center", gap: 5,
                backgroundColor: ACCENT,
                paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999,
              }}
            >
              <Ionicons name="add" size={14} color="#fff" />
              <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>Create</Text>
            </Pressable>
          }
        />

        {loading ? (
          <View style={{ paddingVertical: 40, alignItems: "center" }}>
            <ActivityIndicator color={ACCENT} />
          </View>
        ) : myEvents.length === 0 ? (
          <View
            style={{
              marginHorizontal: 16, backgroundColor: "#1C1C1E", borderRadius: 18,
              paddingVertical: 36, alignItems: "center", gap: 12,
            }}
          >
            <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: "#2A2A2A", alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="calendar-outline" size={26} color="#444" />
            </View>
            <View style={{ alignItems: "center", gap: 4 }}>
              <Text style={{ color: "#fff", fontSize: 15, fontWeight: "600" }}>No events yet</Text>
              <Text style={{ color: "#555", fontSize: 13 }}>Events you create will appear here</Text>
            </View>
            <Pressable
              onPress={() => router.push("/CreateEvent")}
              style={{
                marginTop: 4, flexDirection: "row", alignItems: "center", gap: 6,
                backgroundColor: ACCENT, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 999,
              }}
            >
              <Ionicons name="add" size={16} color="#fff" />
              <Text style={{ color: "#fff", fontWeight: "700", fontSize: 14 }}>Create your first event</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 10 }}>
            {myEvents.map((item) => (
              <View key={item.id}>
                <EventCard item={item} onPress={() => openEventDetail(item)} />
                <Pressable
                  onPress={() => router.push(`/manage/${item.id}`)}
                  style={({ pressed }) => ({
                    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
                    backgroundColor: pressed ? "#252525" : "#1C1C1E",
                    marginTop: 2, borderRadius: 12,
                    paddingVertical: 10,
                  })}
                >
                  <Ionicons name="settings-outline" size={14} color="#888" />
                  <Text style={{ color: "#888", fontSize: 13, fontWeight: "600" }}>Manage Event</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}

        {/* ── Joined Events ── */}
        <SectionHeader title="JOINED EVENTS" />
        {loading ? (
          <View style={{ paddingVertical: 24, alignItems: "center" }}>
            <ActivityIndicator color={ACCENT} />
          </View>
        ) : joinedEvents.length === 0 ? (
          <View
            style={{
              marginHorizontal: 16, backgroundColor: "#1C1C1E", borderRadius: 18,
              paddingVertical: 28, alignItems: "center", gap: 8,
            }}
          >
            <Ionicons name="people-outline" size={26} color="#333" />
            <Text style={{ color: "#555", fontSize: 13 }}>Events you RSVP to will appear here</Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 10 }}>
            {joinedEvents.map((item) => (
              <EventCard key={item.id} item={item} onPress={() => openEventDetail(item)} />
            ))}
          </View>
        )}

        {/* ── Settings ── */}
        <SectionHeader title="SETTINGS" />
        <View style={{ marginHorizontal: 16, backgroundColor: "#1C1C1E", borderRadius: 18, overflow: "hidden" }}>
          <SettingRow
            icon="notifications-outline"
            label="Push Notifications"
            rightElement={
              <Switch
                value={notificationsEnabled}
                onValueChange={setNotificationsEnabled}
                trackColor={{ false: "#333", true: ACCENT }}
                thumbColor="#fff"
              />
            }
          />
          <RowSeparator />
          <SettingRow
            icon="help-circle-outline"
            label="Help & Feedback"
            onPress={() => Alert.alert("Help & Feedback", "Contact us at hello@uspot.app")}
          />
          <RowSeparator />
          <SettingRow
            icon="information-circle-outline"
            label="About uSpot"
            onPress={() => Alert.alert("uSpot", "Find events, free food, and library spaces.\n\nVersion 0.1.0")}
          />
          <RowSeparator />
          <SettingRow
            icon="log-out-outline"
            label="Sign Out"
            danger
            onPress={() =>
              Alert.alert("Sign Out", "Are you sure?", [
                { text: "Cancel", style: "cancel" },
                { text: "Sign Out", style: "destructive", onPress: () => supabase.auth.signOut() },
              ])
            }
          />
        </View>
      </ScrollView>

      <View style={{ position: "absolute", left: 0, right: 0, bottom: 18 }}>
        <BottomNav />
      </View>
    </SafeAreaView>
  );
}
