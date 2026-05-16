/**
 * AuthField — shared form input used by the login and sign-up screens.
 *
 * Extracted from auth/login.tsx to avoid duplication. Provides:
 *  - Leading icon from Ionicons
 *  - Optional password-reveal toggle (eye icon)
 *  - Consistent dark-mode styling that matches the rest of the app
 */

import React, { useState } from "react";
import { View, TextInput, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";

type Props = {
  icon: keyof typeof Ionicons.glyphMap;
  placeholder: string;
  value: string;
  onChangeText: (v: string) => void;
  secureTextEntry?: boolean;
  keyboardType?: "email-address" | "default";
  autoCapitalize?: "none" | "sentences" | "words";
};

export function AuthField({
  icon,
  placeholder,
  value,
  onChangeText,
  secureTextEntry,
  keyboardType,
  autoCapitalize,
}: Props) {
  // Controls password-reveal toggle — local UI state only, no persistence needed.
  const [show, setShow] = useState(false);

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: "#1C1C1E",
        borderRadius: 14,
        paddingHorizontal: 14,
        height: 52,
        gap: 10,
      }}
    >
      <Ionicons name={icon} size={18} color="#555" />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#444"
        secureTextEntry={secureTextEntry && !show}
        keyboardType={keyboardType ?? "default"}
        autoCapitalize={autoCapitalize ?? "sentences"}
        autoCorrect={false}
        style={{ flex: 1, color: "#fff", fontSize: 15 }}
      />
      {secureTextEntry && (
        <Pressable onPress={() => setShow((s) => !s)}>
          <Ionicons
            name={show ? "eye-off-outline" : "eye-outline"}
            size={18}
            color="#555"
          />
        </Pressable>
      )}
    </View>
  );
}
