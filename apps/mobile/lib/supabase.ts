/**
 * Supabase client and database type definitions.
 *
 * Architecture:
 *  - A single Supabase client instance is created here and imported everywhere.
 *  - Auth sessions are persisted via expo-secure-store (encrypted on-device).
 *  - iOS SecureStore has a hard 2 KB per-item limit; the adapter below chunks
 *    large JWT tokens across multiple keys to work around that constraint.
 *
 * Security:
 *  - All sensitive queries are enforced server-side via Supabase Row-Level
 *    Security (RLS) policies. Client-side ownership checks are defence-in-depth
 *    only — never the primary security boundary.
 *  - The anon key is safe to ship in the client bundle; it provides no
 *    elevated privileges. RLS policies govern what an anon or authenticated
 *    user can read/write.
 *  - EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY are injected
 *    at build time via Expo's environment variable system; they must NOT be
 *    committed to source control.
 */

import { createClient } from "@supabase/supabase-js";
import * as SecureStore from "expo-secure-store";

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

// iOS SecureStore limit is ~2 KB per key. JWTs can exceed this, so we split
// large values into 1800-byte chunks and reassemble on read.
const CHUNK = 1_800;

const SecureStoreAdapter = {
  getItem: async (key: string): Promise<string | null> => {
    // Try direct (un-chunked) read first for speed.
    const direct = await SecureStore.getItemAsync(key);
    if (direct !== null) return direct;

    // Fall back to reassembling chunks written by a previous setItem call.
    const parts: string[] = [];
    let i = 0;
    while (true) {
      const part = await SecureStore.getItemAsync(`${key}.${i}`);
      if (part === null) break;
      parts.push(part);
      i++;
    }
    return parts.length > 0 ? parts.join("") : null;
  },

  setItem: async (key: string, value: string): Promise<void> => {
    if (value.length <= CHUNK) {
      await SecureStore.setItemAsync(key, value);
      return;
    }
    // Remove any existing un-chunked key before writing chunks to avoid
    // a mixed state where both the direct key and chunk keys exist.
    await SecureStore.deleteItemAsync(key).catch(() => {});
    const count = Math.ceil(value.length / CHUNK);
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        SecureStore.setItemAsync(
          `${key}.${i}`,
          value.slice(i * CHUNK, (i + 1) * CHUNK)
        )
      )
    );
  },

  removeItem: async (key: string): Promise<void> => {
    await SecureStore.deleteItemAsync(key).catch(() => {});
    // Also clear any chunk keys written by a previous chunked setItem.
    for (let i = 0; i < 20; i++) {
      const exists = await SecureStore.getItemAsync(`${key}.${i}`);
      if (exists === null) break;
      await SecureStore.deleteItemAsync(`${key}.${i}`);
    }
  },
};

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: SecureStoreAdapter,
    autoRefreshToken: true,
    persistSession: true,
    // URL-based session detection is not applicable in a native app context.
    detectSessionInUrl: false,
  },
});

// ─── Database row types ───────────────────────────────────────────────────────
// These mirror the Supabase table schemas exactly. Keep in sync with any
// database migrations. Type assertions on query results reference these.

/** Row from the `events` table. All nullable fields match the schema. */
export type DBEvent = {
  id: string;
  title: string;
  org: string;
  location: string;
  color: string;
  event_time: string | null;
  event_date: string | null;
  has_free_food: boolean;
  categories: string[] | null;
  /** Latitude from Mapbox retrieve — null if location was typed without autocomplete. */
  latitude: number | null;
  /** Longitude from Mapbox retrieve — null if location was typed without autocomplete. */
  longitude: number | null;
  description: string | null;
  /** Public URL of the event banner in the `event-images` Storage bucket. */
  image_url: string | null;
  /** Auth user ID of the creator. Null only for legacy/seeded data. */
  created_by: string | null;
  created_at: string;
};

/** Row from the `profiles` table. Created automatically by a DB trigger on signup. */
export type DBProfile = {
  id: string; // matches auth.users.id
  full_name: string | null;
  class_year: string | null;
  major: string | null;
  bio: string | null;
  /** Public URL of the avatar in the `avatars` Storage bucket. Cache-busted with ?t=timestamp on upload. */
  avatar_url: string | null;
  created_at: string;
};

/** Row from the `rsvps` table. Composite unique constraint on (event_id, user_id). */
export type DBRsvp = {
  id: string;
  event_id: string;
  user_id: string;
  created_at: string;
};

/**
 * Row from the `notifications` table.
 * Notifications are written by a Postgres trigger (on rsvps insert) and by
 * the server when sending reminders or event updates.
 */
export type DBNotification = {
  id: string;
  user_id: string;
  type: "rsvp" | "reminder" | "update";
  title: string;
  body: string;
  /** The related event, if any. Used for future deep-link navigation. */
  event_id: string | null;
  read: boolean;
  created_at: string;
};
