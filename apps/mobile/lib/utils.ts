/**
 * Shared utility functions used across multiple screens.
 *
 * Rules for what lives here:
 *  - Pure functions with no React/UI dependencies
 *  - Logic that appears in more than one file
 *  - Business-logic helpers that warrant a single authoritative implementation
 *
 * Data flow: screens import from here; this module has no knowledge of screens.
 */

import { PALETTE } from "./constants";
import { DBEvent } from "./supabase";
import { EventItem } from "../app/components/EventCard";

// ─── Avatar helpers ───────────────────────────────────────────────────────────

/**
 * Returns a deterministic colour from PALETTE for a given userId.
 *
 * O(1) — uses the first character code so the colour is stable across
 * sessions and requires no database lookup or stored preference.
 */
export function avatarColor(userId: string): string {
  return PALETTE[userId.charCodeAt(0) % PALETTE.length];
}

// ─── Time formatting ──────────────────────────────────────────────────────────

/**
 * Returns a compact relative timestamp string (e.g. "3m ago", "2h ago", "1d ago").
 * Used in the notifications inbox and the manage-event attendee list.
 */
export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ─── Date parsing / normalisation ────────────────────────────────────────────

/**
 * Month-name → 0-indexed month number look-up.
 * Supports both short ("jan") and full ("january") forms.
 */
const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  january: 0, february: 1, march: 2, april: 3, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

/**
 * Parses a free-text event date string into a local Date at midnight.
 *
 * Uses the `new Date(year, month, day)` constructor rather than parsing ISO
 * strings — the ISO string form has timezone edge cases in Hermes (React Native's
 * JS engine) that cause "off-by-one day" bugs on certain devices.
 *
 * Supports:
 *  - "today" / "tomorrow"
 *  - "May 13"
 *  - "May 13, 2026"
 */
export function parseDateStr(s: string): Date | null {
  const t = s.trim();
  const now = new Date();
  const year = now.getFullYear();

  if (/^today$/i.test(t)) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (/^tomorrow$/i.test(t)) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1);
    return d;
  }

  const m = /^([A-Za-z]+)\s+(\d{1,2})(?:,?\s*(\d{4}))?$/.exec(t);
  if (m) {
    const monthIdx = MONTH_INDEX[m[1].toLowerCase()];
    if (monthIdx !== undefined) {
      const day = parseInt(m[2], 10);
      const yr = m[3] ? parseInt(m[3], 10) : year;
      return new Date(yr, monthIdx, day, 0, 0, 0, 0);
    }
  }
  return null;
}

/**
 * Normalises a raw event date string from the database into a display label.
 *
 * - Dates that match today's calendar date → "Today"
 * - Dates that match tomorrow's calendar date → "Tomorrow"
 * - Everything else → unchanged (e.g. "May 20", "May 20, 2026")
 *
 * Only called in the event feed (EventScreen). Profile and user screens
 * show raw dates without the Today/Tomorrow normalisation.
 */
export function normalizeDate(raw: string): string {
  const parsed = parseDateStr(raw);
  if (!parsed) return raw;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  if (parsed.getTime() === today.getTime()) return "Today";
  if (parsed.getTime() === tomorrow.getTime()) return "Tomorrow";
  return raw;
}

// ─── Event data transformation ────────────────────────────────────────────────

/**
 * Converts a raw Supabase database row into the EventItem shape consumed by
 * all UI components (EventCard, event detail, map sheet).
 *
 * This is the single source of truth for that transformation. Previously the
 * mapping was duplicated in EventScreen and profile — keeping it here ensures
 * both screens always produce identical shapes from identical data.
 *
 * @param row         Full DBEvent row from Supabase (`select("*")`)
 * @param rsvpCount   Pre-computed attendee count (caller fetches all RSVPs
 *                    in one query and builds a countMap to avoid N+1)
 * @param creatorName Display name of the event creator (batch-fetched by
 *                    caller from the profiles table, optional)
 */
export function toEventItem(
  row: DBEvent,
  rsvpCount = 0,
  creatorName?: string
): EventItem {
  return {
    id: row.id,
    title: row.title,
    org: row.org,
    location: row.location,
    color: row.color,
    time: row.event_time ?? undefined,
    date: row.event_date ? normalizeDate(row.event_date) : undefined,
    hasFreeFood: row.has_free_food,
    categories: row.categories ?? undefined,
    description: row.description ?? undefined,
    imageUrl: row.image_url ?? undefined,
    createdBy: row.created_by ?? undefined,
    creatorName,
    rsvpCount,
    coordinates:
      row.latitude != null && row.longitude != null
        ? { latitude: row.latitude, longitude: row.longitude }
        : undefined,
  };
}

// ─── File upload helpers ──────────────────────────────────────────────────────

/** Maximum avatar file size (5 MB). Enforced client-side before uploading. */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/** Maximum event banner image size (10 MB). */
export const MAX_EVENT_IMAGE_BYTES = 10 * 1024 * 1024;
