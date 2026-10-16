// media-controls · 40 · transport-bar   @promote-candidate
//
// Dependency-free, ZERO studio-domain imports (only React + the sibling
// timecode-display partial). The transport strip: step-back / play-pause /
// step-forward / loop, a divider, the timecode readout, a divider, a render
// counter, and a caller-supplied right slot (music preset / re-render /
// export). All behaviour is prop-driven — the bar holds no play state.
//
// Class API (studio-editor layer): .transport / .transport-left /
// .transport-right / .transport-btn (.transport-btn--play / .is-on) /
// .transport-divider / .transport-counter

import type { ReactNode } from 'react';

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

// ─── Transport bar ────────────────────────────────────────────────────────

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
  /** Right-aligned controls (music preset, re-render, export). */
  rightSlot?: ReactNode;
}

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
}: TransportBarProps) {
  return (
    <div className="transport" role="toolbar" aria-label="Playback controls">
      <div className="transport-left">
        <button
          type="button"
          className="transport-btn"
          onClick={onStepBack}
          disabled={!onStepBack}
          aria-label="Step back one frame"
          title="Step back (,)"
        >
          <IconStepBack />
        </button>

        <button
          type="button"
          className="transport-btn transport-btn--play"
          onClick={onPlayToggle}
          aria-label={playing ? 'Pause' : 'Play'}
          aria-pressed={playing}
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
        >
          {playing ? <IconPause /> : <IconPlay />}
        </button>

        <button
          type="button"
          className="transport-btn"
          onClick={onStepForward}
          disabled={!onStepForward}
          aria-label="Step forward one frame"
          title="Step forward (.)"
        >
          <IconStepForward />
        </button>

        <button
          type="button"
          className={`transport-btn${loop ? ' is-on' : ''}`}
          onClick={onLoopToggle}
          disabled={!onLoopToggle}
          aria-label={loop ? 'Loop on' : 'Loop off'}
          aria-pressed={loop}
          title="Toggle loop"
        >
          <IconLoop />
        </button>

        <div className="transport-divider" aria-hidden="true" />

        <TimecodeDisplay currentMs={currentMs} totalMs={totalMs} fps={fps} playing={playing} announce />

        {counterLabel && (
          <>
            <div className="transport-divider" aria-hidden="true" />
            <span className="transport-counter" aria-label={counterLabel}>
              {counterLabel}
            </span>
          </>
        )}
      </div>

      {rightSlot && <div className="transport-right">{rightSlot}</div>}
    </div>
  );
}
