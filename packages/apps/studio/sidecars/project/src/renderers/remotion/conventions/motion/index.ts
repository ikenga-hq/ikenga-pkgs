/**
 * Motion vocabulary library for com.ikenga.studio Remotion cells (WP-14).
 *
 * Pure functions — no React imports required. Provides curated spring presets
 * and entrance helpers (settle, snap, bloom) + timing helpers (lag, lead, applyOffset).
 *
 * Usage in Remotion cells:
 *   import { settle, snap, bloom, lag, lead, applyOffset, SPRINGS } from "./conventions/motion";
 *   const progress = settle({ frame, fps, startAt: 10 });
 */

// ── Spring config presets ─────────────────────────────────────────────────────

export type SpringPreset = {
  damping: number;
  stiffness: number;
  mass: number;
};

/**
 * Named spring config presets.
 */
export const SPRINGS: Record<string, SpringPreset> = {
  /**
   * Heavy: settles deliberately. Use for cards, sections, body content.
   * Longest settle time (~35 frames at 30fps).
   */
  heavy: { damping: 18, stiffness: 90, mass: 1.0 },

  /**
   * Medium: balanced feel. Use for headlines, stat callouts, primary text.
   * Settles in ~25 frames at 30fps.
   */
  medium: { damping: 14, stiffness: 110, mass: 0.7 },

  /**
   * Light: crisp and snappy. Use for icons, badges, small accents.
   * Settles in ~18 frames at 30fps.
   */
  light: { damping: 12, stiffness: 130, mass: 0.6 },

  /**
   * Bouncy: playful with overshoot. Use for avatars, bloom entrances, bursts.
   * Overshoots ~8% before settling (~22 frames at 30fps).
   */
  bouncy: { damping: 9, stiffness: 150, mass: 0.5 },
} as const;

// ── Shared args type ──────────────────────────────────────────────────────────

export interface EntranceArgs {
  /** Current composition frame. */
  frame: number;
  /** Composition fps. */
  fps: number;
  /**
   * Frame at which the entrance begins. All frames before this return 0.
   * Defaults to 0.
   */
  startAt?: number;
}

// ── Spring & Interpolation Mathematics ────────────────────────────────────────

/**
 * Damped harmonic oscillator physics matching Remotion / CSS springs.
 */
export function spring(options: {
  frame: number;
  fps: number;
  config?: { damping?: number; stiffness?: number; mass?: number; overshootClamping?: boolean };
  from?: number;
  to?: number;
  durationInFrames?: number;
}): number {
  const { frame, fps, config, from = 0, to = 1 } = options;
  if (frame <= 0) return from;

  const damping = config?.damping ?? 10;
  const stiffness = config?.stiffness ?? 100;
  const mass = config?.mass ?? 1;

  const t = frame / fps;
  const omega0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));

  let progress = 0;
  if (zeta < 1) {
    // Underdamped
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
    const envelope = Math.exp(-zeta * omega0 * t);
    progress = 1 - envelope * (Math.cos(omegaD * t) + (zeta * omega0 / omegaD) * Math.sin(omegaD * t));
  } else if (Math.abs(zeta - 1) < 1e-5) {
    // Critically damped
    const envelope = Math.exp(-omega0 * t);
    progress = 1 - envelope * (1 + omega0 * t);
  } else {
    // Overdamped
    const s = omega0 * Math.sqrt(zeta * zeta - 1);
    const c1 = (zeta * omega0 + s) / (2 * s);
    const c2 = (s - zeta * omega0) / (2 * s);
    progress = 1 - (c1 * Math.exp((-zeta * omega0 + s) * t) + c2 * Math.exp((-zeta * omega0 - s) * t));
  }

  if (config?.overshootClamping && progress > 1) {
    progress = 1;
  }
  return from + (to - from) * progress;
}

/**
 * Map an input number from an inputRange to an outputRange.
 */
export function interpolate(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
  options?: {
    extrapolateLeft?: 'clamp' | 'extend' | 'identity';
    extrapolateRight?: 'clamp' | 'extend' | 'identity';
    easing?: (t: number) => number;
  },
): number {
  if (inputRange.length !== outputRange.length || inputRange.length < 2) {
    throw new Error('inputRange and outputRange must have at least 2 elements and equal length');
  }

  const minIn = inputRange[0];
  const maxIn = inputRange[inputRange.length - 1];

  let val = input;
  if (val < minIn && options?.extrapolateLeft === 'clamp') {
    val = minIn;
  }
  if (val > maxIn && options?.extrapolateRight === 'clamp') {
    val = maxIn;
  }

  let i = 0;
  while (i < inputRange.length - 2 && val > inputRange[i + 1]) {
    i++;
  }

  const inStart = inputRange[i];
  const inEnd = inputRange[i + 1];
  const outStart = outputRange[i];
  const outEnd = outputRange[i + 1];

  let t = (val - inStart) / (inEnd - inStart);
  if (options?.easing) {
    t = options.easing(t);
  }
  return outStart + (outEnd - outStart) * t;
}

// ── Entrance helpers ──────────────────────────────────────────────────────────

/**
 * Settle — gentle, deliberate landing.
 *
 * Best for: body content, list items, paragraphs, card sections.
 * Spring: SPRINGS.heavy (damping 18, stiffness 90, mass 1.0).
 * Returns a 0→1 progress value suitable for opacity, scale, translateY, etc.
 */
export function settle({ frame, fps, startAt = 0 }: EntranceArgs): number {
  if (frame < startAt) return 0;
  return spring({
    frame: frame - startAt,
    fps,
    config: SPRINGS.heavy,
  });
}

/**
 * Snap — crisp, punctuated entrance.
 *
 * Best for: headlines, callouts, single-word emphasis, labels.
 * Spring: SPRINGS.light (damping 12, stiffness 130, mass 0.6).
 * Returns a 0→1 progress value.
 */
export function snap({ frame, fps, startAt = 0 }: EntranceArgs): number {
  if (frame < startAt) return 0;
  return spring({
    frame: frame - startAt,
    fps,
    config: SPRINGS.light,
    durationInFrames: 20,
  });
}

/**
 * Bloom — radial scale with slight overshoot.
 *
 * Best for: avatars, stat numerals, badge reveals, burst animations.
 * Spring: SPRINGS.bouncy (damping 9, stiffness 150, mass 0.5).
 * Returns a 0→1+ progress value (may exceed 1 briefly due to overshoot).
 */
export function bloom({ frame, fps, startAt = 0 }: EntranceArgs): number {
  if (frame < startAt) return 0;
  return spring({
    frame: frame - startAt,
    fps,
    config: SPRINGS.bouncy,
  });
}

// ── Timing offset helpers ─────────────────────────────────────────────────────

export interface FrameOffset {
  /** Convert this offset to a number of frames at the given fps. */
  offsetFrames: (fps: number) => number;
  /** The offset in milliseconds (positive = later). */
  ms: number;
}

/**
 * Lag — shift an entrance `ms` milliseconds later than its cue frame.
 *
 * Use when a visual should land slightly after the cue that triggers it.
 */
export function lag(ms: number): FrameOffset {
  return {
    ms,
    offsetFrames: (fps: number) => Math.round((ms / 1000) * fps),
  };
}

/**
 * Lead — shift an entrance `ms` milliseconds earlier than its cue frame.
 *
 * Use when a visual should appear slightly before the cue.
 */
export function lead(ms: number): FrameOffset {
  return {
    ms: ms === 0 ? 0 : -ms,
    offsetFrames: (fps: number) => {
      const frames = Math.round((ms / 1000) * fps);
      return frames === 0 ? 0 : -frames;
    },
  };
}

/**
 * Apply a lag/lead offset to a base frame number. Clamps to 0.
 */
export function applyOffset(
  frame: number,
  offset: FrameOffset,
  fps: number,
): number {
  return Math.max(0, frame + offset.offsetFrames(fps));
}
