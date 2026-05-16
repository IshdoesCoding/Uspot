/**
 * Root layout — session guard and navigation shell.
 *
 * This is the first component that renders. It is responsible for:
 *  1. Hydrating the auth session from SecureStore on app launch.
 *  2. Subscribing to Supabase auth state changes for the lifetime of the app.
 *  3. Redirecting unauthenticated users to /auth/login and authenticated
 *     users out of the /auth group.
 *
 * Auth flow:
 *  - `session === undefined` means we haven't heard back from SecureStore yet
 *    (initial hydration in progress). Show a spinner to avoid a flash of the
 *    wrong screen.
 *  - `session === null` means definitively logged out → redirect to /auth/login.
 *  - `session` is a Session object → redirect out of /auth to the feed.
 *
 * Security note:
 *  This client-side guard is UX convenience. All actual data access is
 *  protected by Supabase Row-Level Security (RLS) on the server. Even if
 *  a user somehow bypassed this redirect, they would not be able to read
 *  or write protected data without a valid session token.
 */

import React, { useEffect, useState } from "react";
import { View, ActivityIndicator } from "react-native";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { ACCENT } from "../lib/constants";

export default function RootLayout() {
  // undefined = loading, null = logged out, Session = logged in
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    // Hydrate from SecureStore on first render.
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));

    // Keep session state in sync whenever the user signs in or out.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_, session) => setSession(session)
    );

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session === undefined) return; // still hydrating — don't redirect yet

    const inAuthGroup = segments[0] === "auth";

    if (!session && !inAuthGroup) {
      // Logged-out user tried to access a protected route.
      router.replace("/auth/login");
    } else if (session && inAuthGroup) {
      // Logged-in user landed on an auth screen (e.g. after deep link).
      router.replace("/");
    }
  }, [session, segments]);

  // Splash screen — shown while we wait for the session to hydrate from disk.
  if (session === undefined) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: "#000",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ActivityIndicator color={ACCENT} size="large" />
      </View>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: "#000" },
        }}
      />
    </>
  );
}
