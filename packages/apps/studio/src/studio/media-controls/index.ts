// media-controls — the generic transport family.   @promote-candidate
//
// Dependency-free, ZERO studio-domain imports (React + the pure `../lib/time`
// foundation only). Reserved app-kit partials: 40 transport-bar ·
// 41 scrubber-playhead · 42 timecode-display + time-ruler · 43 preview-surface
// + media-thumb. Kept import-clean so the earn-it-twice promotion to app-kit
// stays a file-move (lib/time co-promotes as the time foundation).
//
// Class API + props/events freeze under G-EDITOR-API (contract §2).

export { TransportBar } from './transport-bar';
export type { TransportBarProps } from './transport-bar';

export { TimecodeDisplay, TimeRuler, spokenClock, spokenTimecode } from './timecode-display';
export type { TimecodeDisplayProps, TimeRulerProps, TimecodeFormat } from './timecode-display';

export { ScrubberPlayhead, Playhead, PlayheadEcho } from './scrubber-playhead';
export type { ScrubberPlayheadProps, PlayheadProps } from './scrubber-playhead';

export { PreviewSurface, PreviewStatus, MediaThumb, SafeZoneBands } from './preview-surface';
export type {
  PreviewSurfaceProps,
  PreviewStatusProps,
  PreviewStatusKind,
  PreviewAspect,
  MediaThumbProps,
} from './preview-surface';
