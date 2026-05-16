/**
 * Login screen — email/password sign-in.
 *
 * On success, `supabase.auth.signInWithPassword` fires an `onAuthStateChange`
 * event that is picked up by `app/_layout.tsx`, which then automatically
 * redirects the user to the feed ("/"). This screen does not navigate manually
 * on success; the layout handles it.
 *
 * Security:
 *  - Emails are normalised to lowercase before submission.
 *  - Loading state prevents double-submits.
 *  - Errors surfaced by Supabase are shown verbatim (they are user-facing
 *    strings from Supabase and do not expose internal details).
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
import { supabase } from "../../lib/supabase";
import { ACCENT } from "../../lib/constants";
import { AuthField } from "../components/AuthField";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const LOGO = require("../../assets/uSpot.png");

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSignIn = async () => {
    if (!email.trim() || !password) {
      Alert.alert("Fill in all fields.");
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (error) {
        Alert.alert("Sign in failed", error.message);
      }
      // On success, _layout.tsx's onAuthStateChange fires and redirects to "/"
    } catch (e: any) {
      Alert.alert("Error", e?.message ?? "Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
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
              Welcome back
            </Text>
            <Text style={{ color: "#555", fontSize: 15 }}>
              Sign in to discover events at UVA
            </Text>
          </View>

          <View style={{ gap: 12, marginBottom: 24 }}>
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
              placeholder="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
            />
          </View>

          <Pressable
            onPress={handleSignIn}
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
                Sign In
              </Text>
            )}
          </Pressable>

          <View style={{ flexDirection: "row", justifyContent: "center", gap: 5 }}>
            <Text style={{ color: "#555", fontSize: 14 }}>New to uSpot?</Text>
            <Pressable onPress={() => router.push("/auth/signup")}>
              <Text style={{ color: ACCENT, fontSize: 14, fontWeight: "600" }}>
                Create an account
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
