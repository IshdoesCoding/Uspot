/**
 * Design tokens shared across all screens.
 *
 * Centralising colours and palette here means a brand-colour change
 * touches exactly one file rather than every component.
 */

/** Primary accent — used for CTAs, highlights, loading indicators. */
export const ACCENT = "#F7931A";

/** Destructive actions, error states. */
export const DANGER = "#E5403A";

/** Confirmation, "going" / success states. */
export const SUCCESS = "#2BE59A";

/**
 * Avatar colour palette.
 *
 * Colours are assigned deterministically from a user's ID (charCodeAt(0) % length)
 * so the same user always gets the same colour across devices without needing to
 * persist a preference to the database.
 */
export const PALETTE = [
  "#F7931A", // orange
  "#B12BE5", // purple
  "#2B6FE5", // blue
  "#2BE59A", // green
  "#E5403A", // red
  "#E5C12B", // yellow
] as const;

export type PaletteColor = (typeof PALETTE)[number];
