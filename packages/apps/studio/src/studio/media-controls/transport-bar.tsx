// media-controls · 40 · transport-bar   @promote-candidate
//
// Dependency-free, ZERO studio-domain imports (only React + the sibling
// timecode-display partial). The transport strip: step-back / play-pause /
// step-forward / loop, a divider, the timecode readout, a divider, a render
// counter, and a caller-supplied right slot (music preset / re-render /
// export). All behaviour is prop-driven — the bar holds no play state.
//
// Locked design: DS D-10 (transport-bar-strip, Round 7) — beneath the picture,
// speed deferred to P2.
//
// Class API (studio-editor layer): .transport[data-size] / .transport-left /
// .transport-cluster / .transport-readout / .transport-right / .transport-btn
// (.transport-btn--play / .is-on / :disabled) / .transport-divider /
// .transport-counter

import { useLayoutEffect, useRef } from 'react';
import type { FocusEvent, KeyboardEvent, ReactNode } from 'react';

import { TimecodeDisplay } from './timecode-display';

// ─── Inline icons (no lucide dependency — keeps the module import-clean) ──

const IconStepBack = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M19 20L9 12l10-8M5 20V4" />
  </svg>
);
const IconStepForward = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 4l10 8-10 8M19 4v16" />
  </svg>
);
const IconPlay = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
    <path d="M5 3l14 9-14 9V3z" />
  </svg>
);
const IconPause = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
    <path d="M6 4h4v16H6zM14 4h4v16h-4z" />
  </svg>
);
const IconLoop = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3" />
  </svg>
);

/** Speaker glyphs for a consumer's mute toggle (no emoji — they render as
 *  colour bitmaps and ignore currentColor). */
export const IconSpeaker = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 5L6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />
  </svg>
);
export const IconSpeakerMuted = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 5L6 9H2v6h4l5 4V5zM22 9l-6 6M16 9l6 6" />
  </svg>
);

// ─── Transport bar (DS D-10 · hairline strip, Round 7) ────────────────────

export interface TransportBarProps {
  playing: boolean;
  onPlayToggle: () => void;
  onStepBack?: () => void;
  onStepForward?: () => void;
  loop?: boolean;
  onLoopToggle?: () => void;
  currentMs: number;
  totalMs: number;
  fps?: number;
  /** e.g. "4/6 cells rendered" — omit to hide the counter + its divider. */
  counterLabel?: string;
  /** Right-aligned controls (mute / re-render / export). Their <button>s
   *  join the toolbar's arrow-key navigation automatically. */
  rightSlot?: ReactNode;
  /** 'sm' = the Cell mini-preview instance: 24px targets, no counter, no
   *  right slot. */
  size?: 'md' | 'sm';
  /** Disables every playback control (an empty composition). */
  disabled?: boolean;
}

/** One hairline row beneath the picture: [step · play · step · loop] |
 *  timecode | counter ……… right slot. A real APG toolbar: one tab stop,
 *  ←/→/Home/End between its enabled buttons (roving tabindex). Play state is
 *  carried by the play button's LABEL (Play ⇄ Pause) — never aria-pressed as
 *  well; loop is a true toggle (stable label + aria-pressed). */
export function TransportBar({
  playing,
  onPlayToggle,
  onStepBack,
  onStepForward,
  loop = false,
  onLoopToggle,
  currentMs,
  totalMs,
  fps,
  counterLabel,
  rightSlot,
  size = 'md',
  disabled = false,
}: TransportBarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const focusIdxRef = useRef(0);
  const sm = size === 'sm';
  const atStart = currentMs <= 0;
  const atEnd = currentMs >= totalMs;

  const enabledButtons = () =>
    rootRef.current ? [...rootRef.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')] : [];

  // Roving tabindex: exactly one enabled button is tabbable. Re-applied every
  // render because the consumer's right-slot buttons can come and go.
  useLayoutEffect(() => {
    const btns = enabledButtons();
    if (!btns.length) return;
    const idx = Math.min(focusIdxRef.current, btns.length - 1);
    btns.forEach((b, i) => {
      b.tabIndex = i === idx ? 0 : -1;
    });
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const btns = enabledButtons();
    const cur = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (cur < 0) return;
    e.preventDefault();
    const next =
      e.key === 'Home' ? 0
        : e.key === 'End' ? btns.length - 1
          : Math.max(0, Math.min(btns.length - 1, cur + (e.key === 'ArrowRight' ? 1 : -1)));
    focusIdxRef.current = next;
    btns.forEach((b, i) => {
      b.tabIndex = i === next ? 0 : -1;
    });
    btns[next].focus();
  };
  const onFocusCapture = (e: FocusEvent<HTMLDivElement>) => {
    const i = enabledButtons().indexOf(e.target as unknown as HTMLButtonElement);
    if (i >= 0) focusIdxRef.current = i;
  };

  return (
    <div
      ref={rootRef}
      className="transport"
      role="toolbar"
      aria-label="Playback controls"
      data-size={sm ? 'sm' : undefined}
      onKeyDown={onKeyDown}
      onFocusCapture={onFocusCapture}
    >
      <div className="transport-left">
        <div className="transport-cluster">
          <button
            type="button"
            className="transport-btn"
            onClick={onStepBack}
            disabled={disabled || !onStepBack || atStart}
            aria-label="Step back one frame"
            title="Step back (,)"
          >
            <IconStepBack />
          </button>
          <button
            type="button"
            className="transport-btn transport-btn--play"
            onClick={onPlayToggle}
            disabled={disabled}
            aria-label={playing ? 'Pause' : 'Play'}
            title={playing ? 'Pause (Space)' : 'Play (Space)'}
          >
            {playing ? <IconPause /> : <IconPlay />}
          </button>
          <button
            type="button"
            className="transport-btn"
            onClick={onStepForward}
            disabled={disabled || !onStepForward || atEnd}
            aria-label="Step forward one frame"
            title="Step forward (.)"
          >
            <IconStepForward />
          </button>
          <button
            type="button"
            className={`transport-btn${loop ? ' is-on' : ''}`}
            onClick={onLoopToggle}
            disabled={disabled || !onLoopToggle}
            aria-label="Loop"
            aria-pressed={loop}
            title="Loop"
          >
            <IconLoop />
          </button>
        </div>

        <div className="transport-divider" aria-hidden="true" />

        <div className="transport-readout">
          <TimecodeDisplay
            currentMs={currentMs}
            totalMs={totalMs}
            fps={fps}
            playing={playing}
            size={sm ? 'sm' : 'md'}
            announce={!sm}
          />
          {counterLabel && !sm && (
            <>
              <div className="transport-divider" aria-hidden="true" />
              <span className="transport-counter">{counterLabel}</span>
            </>
          )}
        </div>
      </div>

      {rightSlot && !sm && <div className="transport-right">{rightSlot}</div>}
    </div>
  );
}
