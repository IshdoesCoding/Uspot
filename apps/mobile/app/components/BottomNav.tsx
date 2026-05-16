/**
 * BottomNav — floating pill navigation bar shown on the three main screens.
 *
 * Tabs: Home (event feed) · Create Event · Profile
 *
 * Uses `router.replace` instead of `router.push` so back-navigation from a
 * secondary screen (e.g. event detail) never lands the user on a stale tab.
 * No-ops if the user taps the already-active tab to avoid unnecessary re-renders.
 */

import React from "react";
import { View, Text, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { usePathname, useRouter } from "expo-router";

type NavPath = "/" | "/profile" | "/CreateEvent";

const TABS: Array<{
  path: NavPath;
  icon: keyof typeof Ionicons.glyphMap;
  activeIcon: keyof typeof Ionicons.glyphMap;
  label: string;
}> = [
  { path: "/",             icon: "home-outline",        activeIcon: "home",        label: "Home"    },
  { path: "/CreateEvent",  icon: "add-circle-outline",  activeIcon: "add-circle",  label: "Create"  },
  { path: "/profile",      icon: "person-outline",      activeIcon: "person",      label: "Profile" },
];

export default function BottomNav() {
  const router = useRouter();
  const pathname = usePathname();

  const go = (path: NavPath) => {
    if (pathname === path) return;
    router.replace(path);
  };

  return (
    <View style={{ alignItems: "center" }}>
      <View
        style={{
          width: "82%",
          height: 62,
          backgroundColor: "#1C1C1E",
          borderRadius: 999,
          paddingHorizontal: 24,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.4,
          shadowRadius: 12,
          elevation: 10,
        }}
      >
        {TABS.map((tab) => {
          const active = pathname === tab.path;
          return (
            <Pressable
              key={tab.path}
              onPress={() => go(tab.path)}
              style={{
                alignItems: "center",
                gap: 3,
                paddingVertical: 6,
                paddingHorizontal: 14,
              }}
            >
              <Ionicons
                name={active ? tab.activeIcon : tab.icon}
                size={24}
                color={active ? "#fff" : "#555"}
              />
              <Text
                style={{
                  color: active ? "#fff" : "#555",
                  fontSize: 10,
                  fontWeight: active ? "700" : "500",
                }}
              >
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
