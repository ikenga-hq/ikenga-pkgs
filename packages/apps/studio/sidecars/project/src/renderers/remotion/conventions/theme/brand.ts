/**
 * BrandPalette — the 8-key colour contract every primitive reads.
 *
 * Consumed via `usePalette()` (from BrandProvider.tsx).
 *
 * Naming convention:
 *   bg        = outermost background
 *   surface   = card / panel background
 *   border    = hairline / stroke colour
 *   accent    = interactive / brand colour (buttons, links, icons)
 *   highlight = brighter variant of accent (text callouts, glow rings)
 *   textPri   = primary body text
 *   textSec   = muted / label text
 *   accent2   = optional second accent for bi-colour compositions
 */
export type BrandPalette = {
  bg: string;
  surface: string;
  border: string;
  accent: string;
  highlight: string;
  textPri: string;
  textSec: string;
  /** Optional second accent for bi-colour compositions. */
  accent2?: string;
};

/**
 * BrandPaletteWithMode extends BrandPalette with the `lofi` flag.
 *
 * When `lofi: true` the BrandProvider automatically substitutes a
 * wireframe-grayscale palette so primitives can render cheap stills
 * for beat-sheet review (Rung 1). Primitives also suppress
 * any CSS `boxShadow` / gradient / glow effects when `palette.lofi` is true.
 */
export type BrandPaletteWithMode = BrandPalette & {
  /** Set true for wireframe-grayscale rendering (Rung 1 lo-fi). */
  lofi?: boolean;
};

// ── Default palette ────────────────────────────────────────────────────────
//
// Dark teal "Ask Roy" palette — default for Studio Remotion cells.
export const defaultPalette: BrandPaletteWithMode = {
  bg: '#002626',
  surface: '#003333',
  border: '#004d4d',
  accent: '#00807f',
  highlight: '#66cccc',
  textPri: '#f0f5f5',
  textSec: '#b3c4c4',
};

// ── Lo-fi wireframe palette ────────────────────────────────────────────────
//
// Grayscale substitution used when lofi=true.
export const lofiPalette: BrandPaletteWithMode = {
  bg: '#fafafa',
  surface: '#eeeeee',
  border: '#cccccc',
  accent: '#888888',
  highlight: '#555555',
  textPri: '#222222',
  textSec: '#666666',
  lofi: true,
};
