// media-controls · 42 · timecode-display + time-ruler   @promote-candidate
//
// Dependency-free, ZERO studio-domain imports. The ONLY cross-import is the
// pure time foundation (`../lib/time`, G-TIME-MODEL) — it co-promotes with
// this module as app-kit partial 42. No `fmt()` is re-implemented here
// (contract §3): fmtClock / fmtTimecode are the only formatters.
//
// Locked designs: DS D-03 (timecode-display-inline, Round 5) · D-04
// (time-ruler-graduated, Round 5).
//
// Class API (studio-editor layer): .timecode[data-format][data-size] /
// .timecode-current / .timecode-lead / .timecode-sep / .timecode-total ·
// .time-ruler / .time-ruler-tick (.is-major/.is-mid/.is-minor/.is-first/
// .is-last) / .time-ruler-label

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { DEFAULT_FPS, fmtClock, fmtTimecode, rulerTicks } from '../lib/time';

// ─── Spoken forms (built from the displayed strings, so ear == eye) ───────

const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "0:08.4" → "8.4 seconds" · "1:00.0" → "1 minute" · "1:12.5" → "1 minute 12.5 seconds". */
export function spokenClock(ms: number): string {
  const [m, s] = fmtClock(ms).split(':');
  const min = Number(m);
  const sec = Number(s);
  if (min === 0) return unit(sec, 'second');
  return sec === 0 ? unit(min, 'minute') : `${unit(min, 'minute')} ${unit(sec, 'second')}`;
}

/** "00:00:08:12" → "8 seconds, frame 12". */
export function spokenTimecode(ms: number, fps: number = DEFAULT_FPS): string {
  const [hh, mm, ss, ff] = fmtTimecode(ms, fps).split(':').map(Number);
  const parts: string[] = [];
  if (hh) parts.push(unit(hh, 'hour'));
  if (mm) parts.push(unit(mm, 'minute'));
  parts.push(unit(ss, 'second'));
  return `${parts.join(' ')}, frame ${ff}`;
}

/** Split an SMPTE string into its quiet leading run (zeros + colons) and the
 *  significant digits: "00:00:08:12" → ["00:00:0", "8:12"]. */
function splitLead(str: string): [string, string] {
  const m = /^([0:]*)/.exec(str);
  let lead = m ? m[1] : '';
  if (lead.length === str.length) lead = str.slice(0, -1);
  return [lead, str.slice(lead.length)];
}

const isSliderFocused = () =>
  typeof document !== 'undefined' && document.activeElement?.getAttribute('role') === 'slider';

// ─── Timecode display (C11 · D-03) ────────────────────────────────────────

export type TimecodeFormat = 'clock' | 'timecode';

export interface TimecodeDisplayProps {
  currentMs: number;
  totalMs: number;
  /** Frame rate for the SMPTE format. Defaults to DEFAULT_FPS. */
  fps?: number;
  /** 'clock' = M:SS.t (P1) · 'timecode' = HH:MM:SS:FF (P2). A project-level
   *  setting — the readout is not a control (D-03). */
  format?: TimecodeFormat;
  /** 'sm' = the Cell mini-preview instance (--text-micro). */
  size?: 'md' | 'sm';
  /** While true the accessible name is held (no 30 Hz churn); it refreshes on
   *  pause/seek. */
  playing?: boolean;
  /** Set on ONE instance per view: owns the polite announcements (pause, and
   *  seek-settle when the seek did not come from a focused slider). */
  announce?: boolean;
  className?: string;
}

/** `current / total` mono readout. role="timer" (implicit aria-live off) so it
 *  stays silent while playing; the natural-language name is refreshed only
 *  when the playhead settles. */
export function TimecodeDisplay({
  currentMs,
  totalMs,
  fps = DEFAULT_FPS,
  format = 'clock',
  size = 'md',
  playing = false,
  announce = false,
  className,
}: TimecodeDisplayProps) {
  const tc = format === 'timecode';
  const fmt = (ms: number) => (tc ? fmtTimecode(ms, fps) : fmtClock(ms));
  const say = (ms: number) => (tc ? spokenTimecode(ms, fps) : spokenClock(ms));

  // Hold the accessible name while playing.
  const settledRef = useRef(currentMs);
  if (!playing) settledRef.current = currentMs;
  const label = `${say(settledRef.current)} of ${say(totalMs)}`;

  // Announcements (one instance per view).
  const [message, setMessage] = useState('');
  const wasPlayingRef = useRef(playing);
  const firstRef = useRef(true);
  useEffect(() => {
    if (!announce) return;
    if (wasPlayingRef.current && !playing) {
      setMessage(`Paused at ${spokenClock(currentMs)} of ${spokenClock(totalMs)}`);
    }
    wasPlayingRef.current = playing;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, announce]);
  useEffect(() => {
    if (!announce || playing) return;
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    if (isSliderFocused()) return; // the slider's aria-valuetext already voiced it
    const t = setTimeout(() => setMessage(`At ${spokenClock(currentMs)}`), 400);
    return () => clearTimeout(t);
  }, [currentMs, playing, announce]);

  const current = fmt(currentMs);
  const [lead, rest] = tc ? splitLead(current) : ['', current];

  return (
    <div
      className={`timecode${className ? ` ${className}` : ''}`}
      role="timer"
      aria-label={label}
      data-format={tc ? 'timecode' : undefined}
      data-size={size === 'sm' ? 'sm' : undefined}
    >
      <span className="timecode-current">
        {lead && <span className="timecode-lead">{lead}</span>}
        {rest}
      </span>
      <span className="timecode-sep" aria-hidden="true">
        /
      </span>
      <span className="timecode-total">{fmt(totalMs)}</span>
      {announce && (
        <span className="sr-only" aria-live="polite">
          {message}
        </span>
      )}
    </div>
  );
}

// ─── Time ruler (C12 · D-04 graduated) ────────────────────────────────────

/** The frozen --ruler-step-set (G-TIME-MODEL). Sub-tiers are drawn ONLY from
 *  these steps — nothing new is invented. */
const STEP_SET_MS = [1000, 5000, 10000, 30000, 60000];
/** A sub-tier is dropped when its ticks would sit closer than this. */
const MIN_SUB_PX = 6;
/** Major labels thin to every other one below this pitch (D-04 gate P2). */
const MIN_LABEL_PITCH_PX = 40;

export interface TimeRulerProps {
  totalMs: number;
  /** P2 zoom window. Defaults to [0, totalMs]. */
  viewStartMs?: number;
  viewEndMs?: number;
  fps?: number;
  className?: string;
}

/** Cosmetic tick label — "10s" under a minute, "M:SS" from a minute. Purely a
 *  ruler presentation concern, not core time math. */
function tickLabel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Majors from the frozen rulerTicks(span). rulerTicks only describes
 *  [0, span], so a zoom window reads the step off it and re-anchors it to
 *  absolute multiples (presentation, not a time.ts change). */
function majorTicks(viewStart: number, viewEnd: number): { step: number; ticks: number[] } {
  const span = viewEnd - viewStart;
  const rel = rulerTicks(span);
  const step = rel.length > 1 ? rel[1] - rel[0] : span;
  if (viewStart === 0) return { step, ticks: rel };
  const ticks: number[] = [];
  for (let t = Math.ceil(viewStart / step) * step; t <= viewEnd + 0.5; t += step) ticks.push(t);
  return { step, ticks };
}

/** Graduated ruler: labeled majors, plus mid/minor ticks from the frozen step
 *  set that divide the major step; a tier drops below MIN_SUB_PX. Baseline-
 *  docked onto the rail. aria-hidden — the timecode + scrubber carry the
 *  accessible position. */
export function TimeRuler({ totalMs, viewStartMs = 0, viewEndMs, className }: TimeRulerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const viewEnd = viewEndMs ?? totalMs;
  const span = Math.max(1, viewEnd - viewStartMs);
  const pct = (t: number) => ((t - viewStartMs) / span) * 100;
  const { step, ticks } = majorTicks(viewStartMs, viewEnd);

  const subs = STEP_SET_MS.filter((s) => s < step && step % s === 0)
    .sort((a, b) => b - a)
    .slice(0, 2);
  const tiers: Array<[string, number]> =
    subs.length === 2 ? [['is-mid', subs[0]], ['is-minor', subs[1]]] : subs.map((s) => ['is-minor', s]);
  const subTicks: Array<{ t: number; cls: string }> = [];
  if (width > 0) {
    const seen = new Set(ticks);
    for (const [cls, s] of tiers) {
      if ((s / span) * width < MIN_SUB_PX) continue;
      for (let t = Math.ceil(viewStartMs / s) * s; t <= viewEnd + 0.5; t += s) {
        if (seen.has(t)) continue;
        seen.add(t);
        subTicks.push({ t, cls });
      }
    }
  }

  // Label thinning: below MIN_LABEL_PITCH_PX label every other major, always
  // keeping the end label (so 0s and the total stay legible).
  const thin = width > 0 && (step / span) * width < MIN_LABEL_PITCH_PX;
  const last = ticks.length - 1;
  const labelled = (i: number) => {
    if (!thin) return true;
    if (i === last) return true;
    if (last % 2 === 1 && i === last - 1) return false;
    return i % 2 === 0;
  };

  return (
    <div ref={ref} className={`time-ruler${className ? ` ${className}` : ''}`} aria-hidden="true">
      {subTicks.map(({ t, cls }) => (
        <div key={`s${t}`} className={`time-ruler-tick ${cls}`} style={{ left: `${pct(t)}%` }} />
      ))}
      {ticks.map((t, i) => {
        const p = pct(t);
        const edge = p <= 0.5 ? ' is-first' : p >= 99.5 ? ' is-last' : '';
        return (
          <div key={t} className={`time-ruler-tick is-major${edge}`} style={{ left: `${p}%` }}>
            {labelled(i) && <span className="time-ruler-label">{tickLabel(t)}</span>}
          </div>
        );
      })}
    </div>
  );
}

// Re-export so consumers that only need the frame rate constant don't reach
// past the module boundary.
export { DEFAULT_FPS };
