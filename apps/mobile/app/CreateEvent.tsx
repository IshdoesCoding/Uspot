/**
 * Create Event screen.
 *
 * Allows an authenticated user to compose and publish a new campus event.
 *
 * Form fields:
 *  - Title (required)
 *  - Organization / club name
 *  - Location (required) — powered by Mapbox Search Box v6 autocomplete
 *  - Date + Time (free text, validated at display time by parseDateStr)
 *  - Description
 *  - Categories (multi-select, stored as string[])
 *  - Accent colour (chosen from a fixed palette)
 *  - Banner image (optional, uploaded to the event-images Storage bucket)
 *
 * Location search (Mapbox Search Box v6):
 *  Two-step flow: suggest → retrieve.
 *  - `suggest` returns lightweight candidates (name + mapbox_id) biased to UVA campus.
 *  - `retrieve` resolves a mapbox_id to exact coordinates (lon, lat).
 *  - A session token groups both calls for Mapbox billing efficiency. It is
 *    reset after each retrieve so the next search starts a fresh session.
 *  - Debounced at 350 ms to avoid excessive API calls while the user types.
 *
 * Image upload:
 *  - Max size: 10 MB (enforced client-side before upload).
 *  - Aspect ratio locked to 16:9 by ImagePicker.
 *  - Uploaded to the `event-images` bucket as `{timestamp}.{ext}`.
 *  - On upload failure the event is still posted (image is optional).
 *
 * Security:
 *  - An explicit auth check runs before the DB insert. If somehow the user
 *    session expired mid-session, the submit is blocked with an error.
 *  - `created_by` is set server-side from auth.uid() via RLS policy;
 *    the client passes `user.id` as a convenience but RLS ignores it
 *    if it doesn't match the authenticated session.
 *  - The Mapbox token is public (EXPO_PUBLIC_) and scoped to Search Box only.
 *    It does not grant write access to any Mapbox resource.
 */

import React, { useState, useRef } from "react";
import {
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Image,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { supabase } from "../lib/supabase";
import { MAX_EVENT_IMAGE_BYTES } from "../lib/utils";

const MAPBOX_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? "";

const CATEGORIES = [
  { key: "social",    label: "Social",    icon: "people-outline"              },
  { key: "academic",  label: "Academic",  icon: "school-outline"              },
  { key: "free_food", label: "Free Food", icon: "fast-food-outline"           },
  { key: "workshop",  label: "Workshop",  icon: "hammer-outline"              },
  { key: "sports",    label: "Sports",    icon: "football-outline"            },
  { key: "other",     label: "Other",     icon: "ellipsis-horizontal-outline" },
] as const;

const COLORS = ["#F7931A", "#B12BE5", "#2B6FE5", "#2BE59A", "#E5403A", "#E5C12B"];

function FieldLabel({ label, required }: { label: string; required?: boolean }) {
  return (
    <Text
      style={{
        color: "#888", fontSize: 12, fontWeight: "600",
        letterSpacing: 0.5, marginBottom: 8,
      }}
    >
      {label}
      {required && <Text style={{ color: "#E5403A" }}> *</Text>}
    </Text>
  );
}

function InputField({
  value,
  onChangeText,
  placeholder,
  multiline,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  multiline?: boolean;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor="#444"
      multiline={multiline}
      style={{
        backgroundColor: "#1C1C1E",
        borderRadius: 12,
        paddingHorizontal: 14,
        paddingVertical: 13,
        color: "#fff",
        fontSize: 15,
        minHeight: multiline ? 80 : undefined,
        textAlignVertical: multiline ? "top" : undefined,
      }}
    />
  );
}

export default function CreateEvent() {
  const router = useRouter();

  const [title, setTitle]               = useState("");
  const [org, setOrg]                   = useState("");
  const [locationName, setLocationName] = useState("");
  const [locationCoords, setLocationCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locationSuggestions, setLocationSuggestions] = useState<any[]>([]);
  const [locationLoading, setLocationLoading]         = useState(false);
  // Debounce timer ref — cleared on each keystroke, fires after 350 ms of silence.
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Session token groups suggest+retrieve calls for Mapbox billing efficiency.
  const sessionTokenRef = useRef(`uspot-${Date.now()}`);
  const [date, setDate]               = useState("");
  const [time, setTime]               = useState("");
  const [description, setDescription] = useState("");
  const [categories, setCategories]   = useState<string[]>([]);
  const [color, setColor]             = useState(COLORS[0]);
  const [imageUri, setImageUri]       = useState<string | null>(null);
  const [submitting, setSubmitting]   = useState(false);

  // ── Location search ───────────────────────────────────────────────────────

  const searchLocation = (text: string) => {
    setLocationName(text);
    setLocationCoords(null); // Coords invalidated whenever the text changes.
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!text.trim()) { setLocationSuggestions([]); return; }

    searchTimerRef.current = setTimeout(async () => {
      setLocationLoading(true);
      try {
        // proximity=-78.508,38.0336 biases results toward UVA's Grounds.
        const url =
          `https://api.mapbox.com/search/searchbox/v1/suggest` +
          `?q=${encodeURIComponent(text.trim())}` +
          `&access_token=${MAPBOX_TOKEN}` +
          `&session_token=${sessionTokenRef.current}` +
          `&proximity=-78.508,38.0336` +
          `&country=us` +
          `&language=en` +
          `&limit=6`;
        const res = await fetch(url);
        const json = await res.json();
        setLocationSuggestions(json.suggestions ?? []);
      } catch {
        setLocationSuggestions([]);
      } finally {
        setLocationLoading(false);
      }
    }, 350);
  };

  const selectLocation = async (suggestion: any) => {
    setLocationSuggestions([]);
    setLocationName(suggestion.name);
    try {
      const url =
        `https://api.mapbox.com/search/searchbox/v1/retrieve/${suggestion.mapbox_id}` +
        `?access_token=${MAPBOX_TOKEN}` +
        `&session_token=${sessionTokenRef.current}`;
      const res = await fetch(url);
      const json = await res.json();
      const coords = json.features?.[0]?.geometry?.coordinates;
      if (coords) {
        setLocationName(json.features[0].properties.full_address ?? suggestion.name);
        setLocationCoords({ lat: coords[1], lng: coords[0] });
      }
    } catch {
      // Coords unavailable — event will post without a map pin.
    }
    // Reset session token so the next search starts a fresh billing session.
    sessionTokenRef.current = `uspot-${Date.now()}`;
  };

  const clearLocation = () => {
    setLocationName("");
    setLocationCoords(null);
    setLocationSuggestions([]);
  };

  // ── Form helpers ──────────────────────────────────────────────────────────

  const toggleCategory = (key: string) => {
    setCategories((prev) =>
      prev.includes(key) ? prev.filter((c) => c !== key) : [...prev, key]
    );
  };

  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Allow photo library access to add an event image.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [16, 9],
      quality: 0.8,
    });
    if (!result.canceled) setImageUri(result.assets[0].uri);
  };

  const removeImage = () => setImageUri(null);

  // ── Submit ────────────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    if (!title.trim()) {
      Alert.alert("Missing info", "Please add an event title.");
      return;
    }
    if (!locationName.trim()) {
      Alert.alert("Missing info", "Please add a location.");
      return;
    }

    // Verify session before touching the DB — guards against mid-session expiry.
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      Alert.alert("Not signed in", "Please sign in to post events.");
      return;
    }

    setSubmitting(true);

    // Upload banner image if one was selected.
    let imageUrl: string | null = null;
    if (imageUri) {
      try {
        const arrayBuffer = await fetch(imageUri).then((r) => r.arrayBuffer());

        // Enforce max file size before uploading to avoid wasted bandwidth.
        if (arrayBuffer.byteLength > MAX_EVENT_IMAGE_BYTES) {
          Alert.alert("Image too large", "Please choose an image under 10 MB.");
          setSubmitting(false);
          return;
        }

        const ext = imageUri.split(".").pop() ?? "jpg";
        const fileName = `${Date.now()}.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from("event-images")
          .upload(fileName, arrayBuffer, { contentType: `image/${ext}` });

        if (!uploadError) {
          const { data } = supabase.storage
            .from("event-images")
            .getPublicUrl(fileName);
          imageUrl = data.publicUrl;
        }
      } catch {
        // Upload failure is non-fatal — the event posts without a banner image.
      }
    }

    const { error } = await supabase.from("events").insert({
      title:       title.trim(),
      org:         org.trim(),
      location:    locationName.trim(),
      event_date:  date.trim() || null,
      event_time:  time.trim() || null,
      description: description.trim() || null,
      categories:  categories.length > 0 ? categories : null,
      // has_free_food is derived from categories for consistency.
      has_free_food: categories.includes("free_food"),
      color,
      image_url:   imageUrl,
      latitude:    locationCoords?.lat ?? null,
      longitude:   locationCoords?.lng ?? null,
      created_by:  user.id,
    });

    setSubmitting(false);

    if (error) {
      Alert.alert("Error", error.message);
      return;
    }

    Alert.alert("Event Created!", `"${title}" is now live on the feed.`, [
      { text: "Done", onPress: () => router.replace("/") },
    ]);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#000" }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* Header */}
        <View
          style={{
            flexDirection: "row", alignItems: "center", justifyContent: "space-between",
            paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16,
          }}
        >
          <Pressable onPress={() => router.replace("/")} style={{ padding: 4 }}>
            <Text style={{ color: "#888", fontSize: 16 }}>Cancel</Text>
          </Pressable>
          <Text style={{ color: "#fff", fontSize: 17, fontWeight: "700" }}>
            Create Event
          </Text>
          <Pressable
            onPress={handleSubmit}
            disabled={submitting}
            style={{
              backgroundColor: submitting ? "#444" : "#fff",
              borderRadius: 999, paddingHorizontal: 16, paddingVertical: 7,
            }}
          >
            <Text
              style={{
                color: submitting ? "#888" : "#000",
                fontSize: 14, fontWeight: "700",
              }}
            >
              {submitting ? "Posting…" : "Post"}
            </Text>
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 48, gap: 20 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* ── Banner preview / image picker ── */}
          <View style={{ position: "relative" }}>
            <View
              style={{
                height: 160, borderRadius: 18, overflow: "hidden",
                backgroundColor: color,
                alignItems: "center", justifyContent: "center",
              }}
            >
              {imageUri ? (
                <Image
                  source={{ uri: imageUri }}
                  style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
                  resizeMode="cover"
                />
              ) : null}

              {/* Live title preview overlaid on the colour/photo */}
              {title ? (
                <>
                  <View
                    style={{
                      position: "absolute", bottom: 0, left: 0, right: 0, height: 70,
                      backgroundColor: "rgba(0,0,0,0.45)",
                    }}
                  />
                  <View style={{ position: "absolute", bottom: 12, left: 14, right: 56 }}>
                    <Text
                      style={{ color: "#fff", fontSize: 18, fontWeight: "700" }}
                      numberOfLines={2}
                    >
                      {title}
                    </Text>
                  </View>
                </>
              ) : null}

              {!imageUri && !title ? (
                <Pressable onPress={pickImage} style={{ alignItems: "center", gap: 6 }}>
                  <Ionicons name="camera-outline" size={28} color="rgba(255,255,255,0.6)" />
                  <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: 13 }}>
                    Tap to add a photo
                  </Text>
                </Pressable>
              ) : null}
            </View>

            {/* Camera / remove controls */}
            <View
              style={{
                position: "absolute", top: 10, right: 10,
                flexDirection: "row", gap: 8,
              }}
            >
              <Pressable
                onPress={pickImage}
                style={{
                  width: 32, height: 32, borderRadius: 16,
                  backgroundColor: "rgba(0,0,0,0.55)",
                  alignItems: "center", justifyContent: "center",
                }}
              >
                <Ionicons name="camera-outline" size={16} color="#fff" />
              </Pressable>
              {imageUri ? (
                <Pressable
                  onPress={removeImage}
                  style={{
                    width: 32, height: 32, borderRadius: 16,
                    backgroundColor: "rgba(0,0,0,0.55)",
                    alignItems: "center", justifyContent: "center",
                  }}
                >
                  <Ionicons name="close" size={16} color="#fff" />
                </Pressable>
              ) : null}
            </View>
          </View>

          {/* Title */}
          <View>
            <FieldLabel label="EVENT TITLE" required />
            <InputField
              value={title}
              onChangeText={setTitle}
              placeholder="e.g. Free Food Mixer"
            />
          </View>

          {/* Organization */}
          <View>
            <FieldLabel label="ORGANIZATION" />
            <InputField
              value={org}
              onChangeText={setOrg}
              placeholder="e.g. CS Club"
            />
          </View>

          {/* Location — Mapbox Search Box autocomplete */}
          <View>
            <FieldLabel label="LOCATION" required />
            <View
              style={{
                backgroundColor: "#1C1C1E",
                borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13,
                flexDirection: "row", alignItems: "center", gap: 10,
              }}
            >
              {/* Green pin when coords are confirmed; search icon while typing. */}
              <Ionicons
                name={locationCoords ? "location" : "search-outline"}
                size={16}
                color={locationCoords ? "#2BE59A" : "#555"}
              />
              <TextInput
                value={locationName}
                onChangeText={searchLocation}
                placeholder="e.g. Newcomb Hall"
                placeholderTextColor="#444"
                autoCorrect={false}
                style={{ flex: 1, color: "#fff", fontSize: 15 }}
              />
              {locationLoading ? (
                <ActivityIndicator size="small" color="#555" />
              ) : locationName.length > 0 ? (
                <Pressable onPress={clearLocation} hitSlop={8}>
                  <Ionicons name="close-circle" size={16} color="#555" />
                </Pressable>
              ) : null}
            </View>

            {/* Suggestion dropdown */}
            {locationSuggestions.length > 0 && (
              <View
                style={{
                  backgroundColor: "#1C1C1E", borderRadius: 12,
                  marginTop: 4, overflow: "hidden",
                }}
              >
                {locationSuggestions.map((s, idx) => (
                  <Pressable
                    key={s.mapbox_id ?? idx}
                    onPress={() => selectLocation(s)}
                    style={({ pressed }) => ({
                      paddingHorizontal: 14, paddingVertical: 12,
                      backgroundColor: pressed ? "#2C2C2E" : "transparent",
                      borderTopWidth: idx > 0 ? 1 : 0,
                      borderTopColor: "#2C2C2E",
                      flexDirection: "row", alignItems: "flex-start", gap: 10,
                    })}
                  >
                    <Ionicons
                      name="location-outline"
                      size={14}
                      color="#666"
                      style={{ marginTop: 2 }}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: "#fff", fontSize: 14 }} numberOfLines={1}>
                        {s.name}
                      </Text>
                      <Text style={{ color: "#555", fontSize: 12 }} numberOfLines={1}>
                        {s.place_formatted ?? s.address ?? ""}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            )}
          </View>

          {/* Date + Time */}
          <View style={{ flexDirection: "row", gap: 12 }}>
            <View style={{ flex: 1 }}>
              <FieldLabel label="DATE" />
              <InputField
                value={date}
                onChangeText={setDate}
                placeholder="e.g. May 15"
              />
            </View>
            <View style={{ flex: 1 }}>
              <FieldLabel label="TIME" />
              <InputField
                value={time}
                onChangeText={setTime}
                placeholder="e.g. 6:00 PM"
              />
            </View>
          </View>

          {/* Description */}
          <View>
            <FieldLabel label="DESCRIPTION" />
            <InputField
              value={description}
              onChangeText={setDescription}
              placeholder="What's happening? Any details students should know…"
              multiline
            />
          </View>

          {/* Categories */}
          <View>
            <FieldLabel label="CATEGORIES" />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {CATEGORIES.map((c) => {
                const active = categories.includes(c.key);
                return (
                  <Pressable
                    key={c.key}
                    onPress={() => toggleCategory(c.key)}
                    style={{
                      flexDirection: "row", alignItems: "center", gap: 6,
                      paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999,
                      backgroundColor: active ? "#fff" : "#1C1C1E",
                    }}
                  >
                    <Ionicons
                      name={c.icon}
                      size={15}
                      color={active ? "#000" : "#666"}
                    />
                    <Text
                      style={{
                        color: active ? "#000" : "#666",
                        fontWeight: active ? "700" : "500",
                        fontSize: 14,
                      }}
                    >
                      {c.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Accent colour */}
          <View>
            <FieldLabel label="ACCENT COLOR" />
            <View style={{ flexDirection: "row", gap: 12 }}>
              {COLORS.map((c) => (
                <Pressable
                  key={c}
                  onPress={() => setColor(c)}
                  style={{
                    width: 36, height: 36, borderRadius: 18, backgroundColor: c,
                    alignItems: "center", justifyContent: "center",
                    borderWidth: color === c ? 2.5 : 0, borderColor: "#fff",
                  }}
                >
                  {color === c && <Ionicons name="checkmark" size={16} color="#fff" />}
                </Pressable>
              ))}
            </View>
          </View>

          {/* Secondary submit button at bottom of form */}
          <Pressable
            onPress={handleSubmit}
            disabled={submitting}
            style={({ pressed }) => ({
              backgroundColor: submitting ? "#333" : pressed ? "#e0e0e0" : "#fff",
              borderRadius: 14, paddingVertical: 15,
              alignItems: "center", marginTop: 4,
            })}
          >
            {submitting ? (
              <ActivityIndicator color="#666" />
            ) : (
              <Text style={{ color: "#000", fontSize: 16, fontWeight: "700" }}>
                Post Event
              </Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
