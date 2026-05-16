/**
 * Sign-up screen — new account creation.
 *
 * Data flow:
 *  1. User fills out name, email, password, and confirm password.
 *  2. Client-side validation runs (non-empty, email format, password length,
 *     password match) to give instant feedback before hitting the network.
 *  3. `supabase.auth.signUp` is called with `full_name` in user metadata.
 *  4. A Postgres trigger (`handle_new_user`) fires on auth.users insert and
 *     creates a matching row in the public `profiles` table, copying full_name.
 *  5a. If Supabase email confirmation is ENABLED: session is null, the user
 *      is sent to login with an instruction to check their email.
 *  5b. If email confirmation is DISABLED (local dev): session is returned and
 *      `_layout.tsx`'s onAuthStateChange redirects to the feed automatically.
 *
 * Security:
 *  - Emails are normalised to lowercase before submission.
 *  - Minimum password length of 8 is enforced client-side (Supabase also
 *    enforces a minimum server-side via project settings).
 *  - Basic email format check prevents obviously invalid submissions.
 *  - Loading state prevents double-submits.
 */

import React, { useState } from "react";
import {
  View,
  Text,
  Pressable,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Image,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { ACCENT } from "../../lib/constants";
import { AuthField } from "../components/AuthField";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const LOGO = require("../../assets/uSpot.png");

/** Simple email format check — catches obvious typos before a network round-trip. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Signup() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSignUp = async () => {
    if (!fullName.trim() || !email.trim() || !password || !confirm) {
      Alert.alert("Fill in all fields.");
      return;
    }
    if (!EMAIL_RE.test(email.trim())) {
      Alert.alert("Enter a valid email address.");
      return;
    }
    if (password.length < 8) {
      Alert.alert("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      Alert.alert("Passwords don't match.");
      return;
    }

    setLoading(true);
    const { data, error } = await supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
      options: {
        // full_name is stored in user metadata and copied to profiles by DB trigger.
        data: { full_name: fullName.trim() },
      },
    });
    setLoading(false);

    if (error) {
      Alert.alert("Sign up failed", error.message);
      return;
    }

    if (!data.session) {
      // Email confirmation is enabled in this Supabase project.
      Alert.alert(
        "Check your email",
        `We sent a confirmation link to ${email.trim().toLowerCase()}. Click it to activate your account, then sign in.`,
        [{ text: "OK", onPress: () => router.replace("/auth/login") }]
      );
    }
    // If session is set, onAuthStateChange in _layout.tsx redirects automatically.
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#000" }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: "center",
            paddingHorizontal: 24,
            paddingBottom: 40,
          }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <Pressable
            onPress={() => router.back()}
            style={{ position: "absolute", top: 8, left: 0, padding: 4 }}
          >
            <Ionicons name="chevron-back" size={22} color="#888" />
          </Pressable>

          <View style={{ alignItems: "center", marginBottom: 48 }}>
            <Image
              source={LOGO}
              style={{ width: 140, height: 40 }}
              resizeMode="contain"
              tintColor="#fff"
            />
          </View>

          <View style={{ marginBottom: 32, gap: 6 }}>
            <Text
              style={{
                color: "#fff",
                fontSize: 28,
                fontWeight: "800",
                letterSpacing: -0.5,
              }}
            >
              Join uSpot
            </Text>
            <Text style={{ color: "#555", fontSize: 15 }}>
              Create an account to post events and more
            </Text>
          </View>

          <View style={{ gap: 12, marginBottom: 24 }}>
            <AuthField
              icon="person-outline"
              placeholder="Full name"
              value={fullName}
              onChangeText={setFullName}
              autoCapitalize="words"
            />
            <AuthField
              icon="mail-outline"
              placeholder="Email"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
            />
            <AuthField
              icon="lock-closed-outline"
              placeholder="Password (min 8 characters)"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
            />
            <AuthField
              icon="lock-closed-outline"
              placeholder="Confirm password"
              value={confirm}
              onChangeText={setConfirm}
              secureTextEntry
              autoCapitalize="none"
            />
          </View>

          {/* Visual password strength indicator — cosmetic only, not a security control. */}
          {password.length > 0 && (
            <View style={{ flexDirection: "row", gap: 4, marginBottom: 20 }}>
              {[1, 2, 3, 4].map((i) => (
                <View
                  key={i}
                  style={{
                    flex: 1,
                    height: 3,
                    borderRadius: 2,
                    backgroundColor:
                      password.length >= i * 3
                        ? i <= 1
                          ? "#E5403A"
                          : i <= 2
                          ? "#E5C12B"
                          : i <= 3
                          ? "#2BE59A"
                          : "#2B6FE5"
                        : "#2A2A2A",
                  }}
                />
              ))}
            </View>
          )}

          <Pressable
            onPress={handleSignUp}
            disabled={loading}
            style={({ pressed }) => ({
              backgroundColor: loading ? "#333" : pressed ? "#e0870f" : ACCENT,
              borderRadius: 14,
              height: 52,
              alignItems: "center",
              justifyContent: "center",
              marginBottom: 16,
            })}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={{ color: "#fff", fontSize: 16, fontWeight: "700" }}>
                Create Account
              </Text>
            )}
          </Pressable>

          <View style={{ flexDirection: "row", justifyContent: "center", gap: 5 }}>
            <Text style={{ color: "#555", fontSize: 14 }}>
              Already have an account?
            </Text>
            <Pressable onPress={() => router.replace("/auth/login")}>
              <Text style={{ color: ACCENT, fontSize: 14, fontWeight: "600" }}>
                Sign in
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
