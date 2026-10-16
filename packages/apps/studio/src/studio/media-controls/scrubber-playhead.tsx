// media-controls · 41 · scrubber-playhead   @promote-candidate
//
// Dependency-free, ZERO studio-domain imports (React + the pure `../lib/time`
// foundation). The scrubber is an absolutely-positioned overlay that fills its
// positioned parent (the timeline-rail); pointer drag + arrow keys translate
// to a single `onSeekMs(ms)` callback — the SINGLE SEEK AUTHORITY (contract
// §4). The consumer snaps to frame and drives the engine's seekTo; this
// component never mutates the playhead position itself.
//
// Locked design: DS D-05 (timeline-rail-split, Round 6) — the seek surface is
// a 24px band over the ruler (`variant="band"`), never an overlay on the clips.
//
// Class API (studio-editor layer): .scrubber (role="slider") · .scrubber--band ·
// .playhead / .playhead-cap · .playhead--echo

import { useRef } from 'react';

import { framesToMs, msToFrames, fmtClock, DEFAULT_FPS } from '../lib/time';

// ─── Playhead line (rail) ─────────────────────────────────────────────────

export interface PlayheadProps {
  /** 0–100 — position across the rail. */
  leftPct: number;
}

export function Playhead({ leftPct }: PlayheadProps) {
  return (
    <div className="playhead" style={{ left: `${leftPct}%` }}>
      <div className="playhead-cap" aria-hidden="true" />
    </div>
  );
}

/** Dimmed echo of the playhead for secondary tracks (waveform). */
export function PlayheadEcho({ leftPct }: PlayheadProps) {
  return (
    <div className="playhead--echo" style={{ left: `${leftPct}%` }} aria-hidden="true" />
  );
}

// ─── Scrubber (interactive seek overlay) ──────────────────────────────────

export interface ScrubberPlayheadProps {
  currentMs: number;
  totalMs: number;
  /** Single seek authority. Fires on click AND throughout a drag. The
   *  consumer snaps to frame + drives the engine's seekTo. */
  onSeekMs: (ms: number) => void;
  /** Fired once on a discrete click (pointer down+up with no meaningful
   *  drag). Lets the consumer ALSO focus the clip under the click without a
   *  drag continuously re-selecting. Playback never triggers this. */
  onSelectMs?: (ms: number) => void;
  /** Fired continuously as the pointer hovers the rail WITHOUT a button
   *  pressed (position in ms), and with `null` on pointer-leave. Because the
   *  scrubber is an absolutely-positioned overlay that fills the whole
   *  timeline-rail, it sits on top of the domain content underneath it (e.g.
   *  clip segments) — native onMouseEnter/onMouseLeave on that underlying
   *  content never fires from a real pointer. This is the pass-through a
   *  consumer needs to re-derive hover state (e.g. hoverBeat) from cursor
   *  position instead. */
  onHoverMs?: (ms: number | null) => void;
  fps?: number;
  /** 'overlay' (legacy: fills its positioned parent) · 'band' (DS D-05: a
   *  24px strip over the ruler; the consumer draws the playhead line). */
  variant?: 'overlay' | 'band';
  /** Cut positions (ms) for [ ] / PageUp / PageDown navigation. Plain
   *  numbers — no domain types cross this boundary. */
  cutsMs?: number[];
  /** Overrides the default fmtClock(currentMs) announcement. */
  ariaValueText?: string;
  ariaLabel?: string;
}

/** px of pointer travel below which a press counts as a click, not a drag. */
const CLICK_SLOP_PX = 4;

export function ScrubberPlayhead({
  currentMs,
  totalMs,
  onSeekMs,
  onSelectMs,
  onHoverMs,
  fps = DEFAULT_FPS,
  variant = 'overlay',
  cutsMs,
  ariaValueText,
  ariaLabel = 'Playhead position',
}: ScrubberPlayheadProps) {
  const ref = useRef<HTMLDivElement>(null);
  const downXRef = useRef<number | null>(null);
  const draggedRef = useRef(false);
  const denom = totalMs > 0 ? totalMs : 1;
  const leftPct = Math.min(100, Math.max(0, (currentMs / denom) * 100));

  const msFromClientX = (clientX: number): number | null => {
    const el = ref.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const ratio = (clientX - rect.left) / rect.width;
    return Math.min(totalMs, Math.max(0, ratio * totalMs));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    // preventDefault also blocks the browser's focus-on-press; a slider that
    // was clicked must own the keyboard next (arrow / [ ] seeks), so focus it.
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    downXRef.current = e.clientX;
    draggedRef.current = false;
    const ms = msFromClientX(e.clientX);
    if (ms !== null) onSeekMs(ms);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    // Mid-drag (pointer captured after a pointerdown): keep driving the seek
    // authority as before.
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      if (downXRef.current !== null && Math.abs(e.clientX - downXRef.current) > CLICK_SLOP_PX) {
        draggedRef.current = true;
      }
      const ms = msFromClientX(e.clientX);
      if (ms !== null) onSeekMs(ms);
      return;
    }
    // Plain hover (no button pressed): this overlay is the only element the
    // pointer ever actually hits, so it is the pass-through point for
    // position-derived hover state.
    if (onHoverMs) {
      const ms = msFromClientX(e.clientX);
      onHoverMs(ms);
    }
  };

  const onPointerLeave = () => {
    onHoverMs?.(null);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // A press with no meaningful travel = a click → also focus the clip.
    if (!draggedRef.current) {
      const ms = msFromClientX(e.clientX);
      if (ms !== null) onSelectMs?.(ms);
    }
    downXRef.current = null;
    draggedRef.current = false;
  };

  // Slider keys (DS D-05): ←/→ ±1 frame · Shift ±1s · [ ] or PageUp/PageDown
  // previous/next cut · Home/End.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const frame = msToFrames(currentMs, fps);
    const oneFrame = framesToMs(1, fps);
    const cuts = cutsMs ? [...cutsMs, totalMs].sort((a, b) => a - b) : null;
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        next = e.shiftKey ? currentMs - 1000 : framesToMs(frame - 1, fps);
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        next = e.shiftKey ? currentMs + 1000 : framesToMs(frame + 1, fps);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = totalMs;
        break;
      case 'PageDown':
      case ']':
        if (!cuts) return;
        next = cuts.find((c) => c > currentMs + oneFrame) ?? totalMs;
        break;
      case 'PageUp':
      case '[':
        if (!cuts) return;
        next = [...cuts].reverse().find((c) => c < currentMs - oneFrame) ?? 0;
        break;
      default:
        return;
    }
    e.preventDefault();
    onSeekMs(Math.min(totalMs, Math.max(0, next)));
  };

  return (
    <div
      ref={ref}
      className={variant === 'band' ? 'scrubber scrubber--band' : 'scrubber'}
      role="slider"
      tabIndex={0}
      aria-valuemin={0}
      aria-valuemax={Math.round(totalMs)}
      aria-valuenow={Math.round(currentMs)}
      aria-valuetext={ariaValueText ?? fmtClock(currentMs)}
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onKeyDown={onKeyDown}
    >
      {variant === 'overlay' && <Playhead leftPct={leftPct} />}
    </div>
  );
}
