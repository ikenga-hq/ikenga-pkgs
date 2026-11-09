// Pure parts of the G-01 harness (preview must equal render). No I/O here, so CI can
// unit-test the measurement and the pass/fail decision without Chrome or FFmpeg.
// The harness itself is g01.ts (needs Chrome + FFmpeg + HyperFrames; CI never runs it).

/** The bar G-01 must clear (plan Round 5). Fixed before any frame was measured. */
export const G01_THRESHOLDS = {
  /** Whole-frame PSNR, RGB average, preview vs reference, per pair. */
  framePsnrDb: 35,
  /** Text/state check: ink IoU inside each text region, per pair. */
  inkIoU: 0.95,
} as const;

/** Five probe times (s) from the plan. All land exactly on a 30 fps frame. */
export const G01_TIMES = [0.5, 1.5, 3.0, 4.5, 5.9] as const;
export const G01_FPS = 30;

export interface Region {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Text regions of the G-01 composition (engines/hyperframes/g01/index.html), in frame pixels.
 * They come from the composition's fixed layout boxes, padded to hold the stat card's
 * entrance (scale 0.85 -> 1, y +60 -> 0).
 */
export const G01_REGIONS: readonly Region[] = [
  { name: 'counter', x: 620, y: 300, w: 680, h: 190 },
  { name: 'caption', x: 470, y: 956, w: 980, h: 56 },
];

/** Luma at or above this is "ink": all text in the composition is light on a dark ground. */
export const INK_LUMA = 128;

export interface PsnrReading {
  r: number;
  g: number;
  b: number;
  average: number;
  min: number;
  max: number;
}

function num(v: string): number {
  return v === 'inf' ? Number.POSITIVE_INFINITY : Number(v);
}

/**
 * Parse FFmpeg's psnr filter summary line, e.g.
 * `[Parsed_psnr_2 @ 0x..] PSNR r:41.2 g:42.0 b:40.9 average:41.3 min:41.3 max:41.3`.
 * Returns null when the line is missing (FFmpeg failed or printed something else).
 */
export function parsePsnr(stderr: string): PsnrReading | null {
  const line = stderr.split(/\r?\n/).reverse().find((l) => /PSNR\s+\S+:/.test(l) && /average:/.test(l));
  if (!line) return null;
  const pick = (key: string): number | undefined => {
    const m = new RegExp(`\\b${key}:(inf|-?[0-9]+(?:\\.[0-9]+)?)`).exec(line);
    return m?.[1] === undefined ? undefined : num(m[1]);
  };
  const average = pick('average');
  if (average === undefined || Number.isNaN(average)) return null;
  return {
    r: pick('r') ?? Number.NaN,
    g: pick('g') ?? Number.NaN,
    b: pick('b') ?? Number.NaN,
    average,
    min: pick('min') ?? average,
    max: pick('max') ?? average,
  };
}

/** PSNR (dB) of two equally sized 8-bit buffers; Infinity when identical. */
export function psnr8(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) throw new Error(`psnr8: size mismatch ${a.length} vs ${b.length}`);
  if (a.length === 0) throw new Error('psnr8: empty buffers');
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] as number) - (b[i] as number);
    sum += d * d;
  }
  if (sum === 0) return Number.POSITIVE_INFINITY;
  const mse = sum / a.length;
  return 10 * Math.log10((255 * 255) / mse);
}

export interface InkComparison {
  /** |A ∩ B| / |A ∪ B| over ink pixels; 1 when both regions hold no ink. */
  iou: number;
  inkA: number;
  inkB: number;
}

/**
 * Compare where the glyphs are, not what they say: threshold both grey regions at
 * `threshold` and take the intersection-over-union of the ink pixels. A different
 * counter value ("0" vs "20"), a different caption, or a different font all move ink;
 * sub-pixel anti-aliasing noise only flips a thin edge. No DOM, no OCR.
 */
export function inkIoU(a: Uint8Array, b: Uint8Array, threshold = INK_LUMA): InkComparison {
  if (a.length !== b.length) throw new Error(`inkIoU: size mismatch ${a.length} vs ${b.length}`);
  let inter = 0;
  let union = 0;
  let inkA = 0;
  let inkB = 0;
  for (let i = 0; i < a.length; i++) {
    const ia = (a[i] as number) >= threshold;
    const ib = (b[i] as number) >= threshold;
    if (ia) inkA++;
    if (ib) inkB++;
    if (ia && ib) inter++;
    if (ia || ib) union++;
  }
  return { iou: union === 0 ? 1 : inter / union, inkA, inkB };
}

export interface RegionResult {
  name: string;
  iou: number;
  psnrDb: number;
}

export interface PairResult {
  time: number;
  framePsnrDb: number;
  regions: RegionResult[];
}

export interface PairVerdict {
  pass: boolean;
  psnrOk: boolean;
  textOk: boolean;
  reasons: string[];
}

export function judgePair(pair: PairResult, t: { framePsnrDb: number; inkIoU: number } = G01_THRESHOLDS): PairVerdict {
  const reasons: string[] = [];
  const psnrOk = pair.framePsnrDb >= t.framePsnrDb;
  if (!psnrOk) reasons.push(`frame PSNR ${fmtDb(pair.framePsnrDb)} < ${t.framePsnrDb} dB`);
  let textOk = pair.regions.length > 0;
  if (!textOk) reasons.push('no text regions measured');
  for (const r of pair.regions) {
    if (!(r.iou >= t.inkIoU)) {
      textOk = false;
      reasons.push(`${r.name} ink IoU ${r.iou.toFixed(3)} < ${t.inkIoU}`);
    }
  }
  return { pass: psnrOk && textOk, psnrOk, textOk, reasons };
}

export interface SetVerdict {
  pass: boolean;
  failedTimes: number[];
}

/** A set passes only when every pair passes. */
export function judgeSet(pairs: PairResult[], t: { framePsnrDb: number; inkIoU: number } = G01_THRESHOLDS): SetVerdict {
  const failedTimes = pairs.filter((p) => !judgePair(p, t).pass).map((p) => p.time);
  return { pass: pairs.length > 0 && failedTimes.length === 0, failedTimes };
}

/** Index of the rendered frame that shows time t (s); throws when t is not on a frame. */
export function frameIndexFor(t: number, fps: number): number {
  const exact = t * fps;
  const idx = Math.round(exact);
  if (Math.abs(exact - idx) > 1e-6) throw new Error(`t=${t}s is not on a ${fps} fps frame boundary`);
  return idx;
}

export function fmtDb(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : 'inf';
}

/**
 * `hyperframes render --format png-sequence` writes RGBA frames with the page ground made
 * transparent and reports that ground on its `@hf-result` line, e.g.
 * `@hf-result {"version":1,"operation":"render","reference_background":{"kind":"solid","rgb":[13,11,10]}}`.
 * The harness composites each reference frame over exactly that colour before comparing.
 * Returns the colour as `0xRRGGBB` for FFmpeg, or null when the line or a solid ground is missing.
 */
export function parseReferenceBackground(output: string): string | null {
  for (const line of output.split(/\r?\n/).reverse()) {
    const i = line.indexOf('@hf-result ');
    if (i < 0) continue;
    try {
      const parsed = JSON.parse(line.slice(i + '@hf-result '.length)) as {
        reference_background?: { kind?: string; rgb?: unknown };
      };
      const bg = parsed.reference_background;
      if (bg?.kind !== 'solid' || !Array.isArray(bg.rgb) || bg.rgb.length !== 3) return null;
      const parts = bg.rgb.map((v) => (typeof v === 'number' && v >= 0 && v <= 255 ? Math.round(v) : Number.NaN));
      if (parts.some((v) => Number.isNaN(v))) return null;
      return `0x${parts.map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('')}`;
    } catch {
      return null;
    }
  }
  return null;
}

/** File name HyperFrames 0.9.19 gives frame `index` (0-based) of a PNG sequence: 1-based, 6 digits. */
export function pngSequenceName(index: number): string {
  return `frame_${String(index + 1).padStart(6, '0')}.png`;
}

// --- What the composition should show (for the report; mirrors g01/index.html) ---

/** GSAP "power2.out" is a cubic ease-out: 1 - (1 - p)^3. */
function power2Out(p: number): number {
  return 1 - (1 - p) ** 3;
}

/** Counter value at timeline time t: 0 -> 20 from 0.3 s over 1.8 s, power2.out, rounded. */
export function expectedCounter(t: number): number {
  const p = Math.min(1, Math.max(0, (t - 0.3) / 1.8));
  return Math.round(20 * power2Out(p));
}

/** Which caption phrase is on screen at time t (fading or full); 0 before the first one. */
export function expectedCaption(t: number): number {
  if (t > 0.2 && t < 2.25) return 1;
  if (t > 2.25 && t < 4.25) return 2;
  if (t > 4.25) return 3;
  return 0;
}

// --- Negative control: the spike's onUpdate-only counter ---

const COUNTER_BLOCK = /\/\* COUNTER:BEGIN \*\/[\s\S]*?\/\* COUNTER:END \*\//;

/** The spike's counter (drafts/spikes/hyperframes/index.html): text set only in onUpdate. */
export const ONUPDATE_COUNTER = `/* COUNTER:BEGIN (negative control: spike's onUpdate-only counter) */
      const numEl = document.getElementById("stat-num");
      const counter = { val: 0 };
      tl.to(counter, {
        val: 20, duration: 1.8, ease: "power2.out",
        onUpdate: function () { numEl.textContent = Math.round(counter.val); }
      }, 0.3);
      /* COUNTER:END */`;

/** Swap the seek-safe counter for the onUpdate-only one; nothing else changes. */
export function makeOnUpdateVariant(html: string): string {
  if (!COUNTER_BLOCK.test(html)) throw new Error('makeOnUpdateVariant: COUNTER:BEGIN/END block not found');
  return html.replace(COUNTER_BLOCK, ONUPDATE_COUNTER);
}
