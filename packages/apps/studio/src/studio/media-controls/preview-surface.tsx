// media-controls · 43 · preview-surface + media-thumb   @promote-candidate
//
// Dependency-free, ZERO studio-domain imports. `PreviewSurface` FRAMES the
// engine render surface (a black box — the HF <hyperframes-player>, Remotion
// <Player>, or Excalidraw canvas); it never restyles the engine (contract §4).
// It only supplies the framed background + the not-ready status affordance.
//
// Class API (studio-editor layer): .preview-surface (.is-rendering /
// .is-queued / .is-pending / .is-failed / .is-cancelled) [data-aspect] ·
// .preview-surface-content · .preview-picture · .preview-status /
// .preview-status-glyph / .preview-status-text / .preview-status-action ·
// .safe-zones / .safe-zone--{action,title,status,caption,rail} /
// .safe-zone__tag · .safe-legend · .preview-aside · .preview-toggle ·
// .media-thumb
//
// D-12 (plans/studio-design-system, Round 8 → designs/preview-surface-band.html):
// the surface is a fixed `--preview-h` band (D-01) that never changes height;
// the PICTURE (`.preview-picture`, the engine's aspect box) is fitted inside it
// via `data-aspect` → the F4 `--aspect-*` vars. 16:9 pillarboxes in a wide
// pane, 9:16 is a tall narrow box, and the transport/timeline below never jump.
//
// D-13 (F4 aspect-safe-area → designs/aspect-safe-area-frozen.html): the 9:16
// overlay is the frozen aspect-9-16 model — SMPTE RP 218 action-safe 5% and
// title-safe 10% insets plus the TikTok/Reels status (8%), caption/CTA (22%)
// and action-rail (14%) zones, drawn over the picture, not the band. It is
// aria-hidden + pointer-events: none (never obscures controls or focus,
// WCAG 2.4.11); the readable key is `SafeZoneLegend`, outside the frame, and
// each zone carries a --text-micro tag on a scrim, so hue is never the only
// cue (1.4.1). Visibility is the consumer's: `SafeZoneToggle` sits outside
// the frame, and `useRememberedToggle` keeps the choice per project.

import { useCallback, useEffect, useState, type ReactNode } from 'react';

export type PreviewStatusKind =
  | 'ready'
  | 'rendering'
  | 'queued'
  | 'pending'
  // Added for contract §8 commit-13 (states-cell.html parity) — the frozen
  // 6-value RenderStatus enum has no home elsewhere for these on the
  // preview surface, so 'failed'/'cancelled' round out the not-ready set.
  | 'failed'
  | 'cancelled';

export type PreviewAspect = '16-9' | '9-16' | '1-1';

export interface PreviewSurfaceProps {
  /** Drives the state class; 'ready' shows the framed engine content. */
  status?: PreviewStatusKind;
  /** F4 aspect-safe-area — sizes the inner picture via `data-aspect`. */
  aspect?: PreviewAspect;
  /** Show the 9:16 safe-zone overlay. Only renders when `aspect === '9-16'`
   *  regardless of this flag (no-op on 16:9/1:1). */
  safeZoneOn?: boolean;
  /** Rendered inside the band but beside the picture (e.g. `SafeZoneLegend`),
   *  so it never changes the band's height. Hidden when the pane is too narrow
   *  to leave room beside a 9:16 picture. */
  aside?: ReactNode;
  ariaLabel?: string;
  children?: ReactNode;
}

export function PreviewSurface({
  status = 'ready',
  aspect = '16-9',
  safeZoneOn = false,
  aside,
  ariaLabel,
  children,
}: PreviewSurfaceProps) {
  const stateClass = status === 'ready' ? '' : ` is-${status}`;
  const showSafeZone = safeZoneOn && aspect === '9-16';
  return (
    <div
      className={`preview-surface${stateClass}`}
      data-aspect={aspect}
      role="img"
      aria-label={ariaLabel}
    >
      <div className="preview-surface-content">
        <div className="preview-picture">
          {children}
          {showSafeZone && <SafeZones />}
        </div>
      </div>
      {aside && <div className="preview-aside">{aside}</div>}
    </div>
  );
}

// ─── Safe zones (F4 aspect-safe-area — shared overlay, D-13) ───────────────
//
// One overlay for the composition preview and the Cell editor preview (contract
// §8 commit-14: "lift it to a shared component rather than duplicating"). Mount
// it last inside any `position: relative` box that IS the 9:16 picture — the
// zones are percentages of that box.
export function SafeZones() {
  return (
    <div className="safe-zones" aria-hidden="true">
      <div className="safe-zone safe-zone--status">
        <span className="safe-zone__tag">Status · clock</span>
      </div>
      <div className="safe-zone safe-zone--caption">
        <span className="safe-zone__tag">Caption · CTA</span>
      </div>
      <div className="safe-zone safe-zone--rail">
        <span className="safe-zone__tag">Actions</span>
      </div>
      <div className="safe-zone safe-zone--action" />
      <div className="safe-zone safe-zone--title" />
    </div>
  );
}

/** @deprecated The two-band draft was superseded by D-13; use `SafeZones`. */
export const SafeZoneBands = SafeZones;

/** The readable key for `SafeZones`, rendered outside the frame. */
export function SafeZoneLegend({ className }: { className?: string }) {
  return (
    <ul className={`safe-legend${className ? ` ${className}` : ''}`} aria-label="Safe-zone key">
      <li><i className="k-action" aria-hidden="true" /><span>Action-safe <small>5% inset</small></span></li>
      <li><i className="k-title" aria-hidden="true" /><span>Title-safe <small>10% · text inside</small></span></li>
      <li><i className="k-status" aria-hidden="true" /><span>Status · clock <small>top 8%</small></span></li>
      <li><i className="k-caption" aria-hidden="true" /><span>Caption · CTA <small>bottom 22%</small></span></li>
      <li><i className="k-rail" aria-hidden="true" /><span>Action rail <small>right 14%</small></span></li>
    </ul>
  );
}

export interface SafeZoneToggleProps {
  pressed: boolean;
  onPressedChange: (next: boolean) => void;
}

/** The overlay switch. Lives outside the frame (never over the picture). */
export function SafeZoneToggle({ pressed, onPressedChange }: SafeZoneToggleProps) {
  return (
    <button
      type="button"
      className="preview-toggle"
      aria-pressed={pressed}
      onClick={() => onPressedChange(!pressed)}
    >
      <svg viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2">
        <rect x="1.5" y="0.5" width="9" height="11" rx="1" />
        <rect x="3" y="2.5" width="6" height="7" rx="0.5" strokeDasharray="1.5 1" />
      </svg>
      Safe zones
    </button>
  );
}

/** A boolean persisted in `localStorage` under `key` (null → in-memory only).
 *  Every access is guarded: an opaque origin, private mode or quota error
 *  degrades to in-memory rather than throwing into the view. */
export function useRememberedToggle(
  key: string | null,
  defaultOn: boolean,
): [boolean, (next: boolean) => void] {
  const read = useCallback((): boolean => {
    if (!key) return defaultOn;
    try {
      const v = globalThis.localStorage?.getItem(key);
      return v === null || v === undefined ? defaultOn : v === '1';
    } catch {
      return defaultOn;
    }
  }, [key, defaultOn]);
  const [on, setOn] = useState(read);
  useEffect(() => setOn(read()), [read]);
  const set = useCallback(
    (next: boolean) => {
      setOn(next);
      if (!key) return;
      try {
        globalThis.localStorage?.setItem(key, next ? '1' : '0');
      } catch {
        /* in-memory only */
      }
    },
    [key],
  );
  return [on, set];
}

// ─── Status overlay (composed as PreviewSurface children when not ready) ──

export interface PreviewStatusProps {
  /** ◐ (rendering) · ○ (queued/pending) · ⚠ (failed) · ✕ (cancelled). */
  glyph?: string;
  text: string;
  /** Optional affordance row (e.g. a Retry button for a failed render). The
   *  consumer owns the click handler/MCP call — this component stays
   *  domain-free. */
  action?: ReactNode;
}

export function PreviewStatus({ glyph = '○', text, action }: PreviewStatusProps) {
  return (
    <div className="preview-status">
      <span className="preview-status-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="preview-status-text">{text}</span>
      {action && <div className="preview-status-action">{action}</div>}
    </div>
  );
}

// ─── Media thumbnail (generic still / poster) ─────────────────────────────

export interface MediaThumbProps {
  src?: string;
  alt?: string;
  /** Placeholder glyph shown when there's no `src`. */
  glyph?: string;
  className?: string;
  style?: React.CSSProperties;
}

export function MediaThumb({
  src,
  alt = '',
  glyph = '▦',
  className,
  style,
}: MediaThumbProps) {
  return (
    <div className={`media-thumb${className ? ` ${className}` : ''}`} style={style}>
      {src ? (
        <img src={src} alt={alt} />
      ) : (
        <span className="media-thumb__glyph" aria-hidden="true">
          {glyph}
        </span>
      )}
    </div>
  );
}
