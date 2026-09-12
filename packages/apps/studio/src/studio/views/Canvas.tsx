// com.ikenga.studio · Canvas view
//
// The Rail — a 1D storyboard. Cells lay out in document flow (scene groups of
// wrapping shot cards) under a project-wide forge-progress rail. Reads REAL
// cells hydrated from disk (storyboard.read) when a real project is open, else
// the __mocks__/cells.ts fixture for standalone dev. Reads `cellUid` from the
// shared store for selection and writes back on every selection change, which
// lights up click-to-focus cross-linking across panes.
//
// Canvas truth:
//   • Cards show REAL per-cell render status (storyboard-store renderStatus,
//     kept fresh by the adaptive poll) — a poster/tick for rendered cells, a
//     pulsing beacon while rendering, honest neutral when un-rendered. Against
//     a real project there is no fake "cell.html" placeholder and no fabricated
//     %: the only progress bar is the mock fixture's own `progress` field, and
//     it is gated on `!hasRealCells` so a real cell can never show one.
//   • The rail summarises the SAME hydrated cells the board renders — it is a
//     projection of `railShots`, not a second data source.
//   • No money anywhere on this board. fal reports no cost field for the models
//     this account runs, so any figure here would be fiction. The only numerals
//     are seed, elapsed, clip duration and shot/scene counts. Spend, if the
//     engine ever reports it, belongs in the Ledger view.
//   • Add / delete cells via the real storyboard.create_cell / delete_cell MCP
//     seams (behind a focus-trapped confirm for delete).
//
// Rung: `rung` is how a shot is MADE, not how finished it is. `beat` is null on
// every cell of every real project, so rungs cannot be fidelity levels of one
// shared shot — there is nothing to pair them on. And the exporter's rung filter
// is optional (exporter.ts resolveCells): Composition.tsx passes `undefined` for
// a real project, so EVERY rung composes into the final video. A board that
// showed hi-fi only would show a film that isn't the film that exports, so the
// board boards every rung and surfaces the rung as a chip on the card — a badge,
// never an axis. What the rung DOES gate is the generation surface: only a hi-fi
// cell has a path to pick (see `Track`).
//
// Visual contract: designs/redesign-ai/canvas-gen-c-novel.html (the rail, the
// drop zone, the seed-lock line, inline failure reasons) grafted with the scene
// grouping + loupe poster from canvas-gen-a-production-desk.html. Role-mapped
// tokens only (--live for the emerald/rendered role, --info for the in-flight
// and Track-B role, --agent for Track A), no raw hex fallbacks.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  selectCellUid,
  selectHoverBeat,
  selectPlayheadMs,
  useSharedStore,
} from '../shared-state';
import { useProjectStore, selectOpenProject } from '../project-store';
import {
  useStoryboardStore,
  selectHydratedCells,
  selectHasRealCells,
  selectHydratedProject,
  selectRenderStatus,
  selectRenderRecords,
  toDisplayCell,
} from '../storyboard-store';
import { useLayoutStore } from '../layout-store';
import { useAnchorsStore, selectAnchors } from '../anchors-store';
import {
  getMcpClient,
  storyboardApi,
} from '../mcp-client';
import { useAsyncAction } from '../lib/use-async-action';
import { useShotGenerate } from '../lib/use-shot-generate';
import { SafeZoneBands } from '../media-controls';
import { CellPoster, prefetchPosters } from './composition/CellPoster';
import { NodeCanvas } from './NodeCanvas';
import type {
  Anchor,
  AspectRatio,
  Cell,
  PromptPlatform,
  RenderRecord,
  RenderStatus,
  Rung,
} from '../mcp-types';
import { rungDir } from '../mcp-types';
import {
  MOCK_CELLS,
  type CellColor,
  type MockCell,
} from '../__mocks__/cells';
import { COMPOSITION_TIMELINE } from '../__mocks__/composition';
import { buildTimelineModel, clipAt } from '../lib/composition-model';
import { deleteCellControlName, nextLaneIndex } from '../lib/canvas-model';
import { EmptyState } from '../components/EmptyState';

// ─── Density ────────────────────────────────────────────────────────────
//
// `strip` is the compact board (wrapping ~198px tickets — scan the whole film);
// `loupe` is the judging density (2-up, 16:9 poster — decide whether a
// generated shot is good). Mirrors the shell's grid/loupe idiom.
//
// NOT spelled `data-density` on the DOM: theme.ts mirrors the shell's OWN
// `data-density` (compact/comfortable chrome density) onto <html>, and a
// same-named attribute here would read as the same axis. This one is
// `data-canvas-density`.

type Density = 'strip' | 'loupe';

const DENSITY_STORAGE_PREFIX = 'studio:canvas-density:';
const densityStorageKey = (projectId: string | null) =>
  `${DENSITY_STORAGE_PREFIX}${projectId ?? 'no-project'}`;

function readDensity(projectId: string | null): Density {
  try {
    const v = localStorage.getItem(densityStorageKey(projectId));
    return v === 'loupe' || v === 'strip' ? v : 'strip';
  } catch {
    return 'strip';
  }
}

// ─── Per-color poster tint (role-mapped tokens; no raw hex) ─────────────

const THUMB_TINT: Record<CellColor, string> = {
  amber:   'bg-[color-mix(in_oklab,var(--achievement)_18%,var(--bg-raised))]',
  rose:    'bg-[color-mix(in_oklab,var(--danger)_18%,var(--bg-raised))]',
  emerald: 'bg-[color-mix(in_oklab,var(--live)_18%,var(--bg-raised))]',
  sky:     'bg-[color-mix(in_oklab,var(--info)_18%,var(--bg-raised))]',
  violet:  'bg-[color-mix(in_oklab,var(--agent)_18%,var(--bg-raised))]',
  neutral: 'bg-raised',
};

// ─── Rung chip ──────────────────────────────────────────────────────────
//
// hi-fi is the default and carries NO chip: a badge on every card is noise.
// Only the two rungs that are made a different way get labelled. (Cell.tsx has
// the same label set; this map is deliberately partial.)
//
// Neutral chrome, not a role colour: --live/--info/--agent/--achievement/--danger
// are all already spoken for here as STATUS or TRACK roles (TILE_STATUS,
// RAIL_NODE_STYLE, the track dot), so a rung chip in --info would read as
// "Track B". The rung is not a state — it reuses the anchor-chip idiom.

const RUNG_CHIP: Partial<Record<Rung, string>> = {
  '1_lofi': 'lo-fi',
  '0_beat_sheet': 'beat sheet',
};

// ─── Render-status → honest tile state ──────────────────────────────────

type TileState = 'rendered' | 'rendering' | 'queued' | 'failed' | 'cancelled' | 'none';

function tileStateFor(status: RenderStatus | undefined): TileState {
  switch (status) {
    case 'done':      return 'rendered';
    case 'running':   return 'rendering';
    case 'queued':    return 'queued';
    case 'failed':    return 'failed';
    case 'cancelled': return 'cancelled';
    default:          return 'none';
  }
}

/** label + role token per tile state — colours resolve under data-theme="A". */
const TILE_STATUS: Record<TileState, { label: string; varName: string }> = {
  rendered:  { label: 'rendered',     varName: '--live' },
  rendering: { label: 'rendering',    varName: '--info' },
  queued:    { label: 'queued',       varName: '--fg-muted' },
  failed:    { label: 'failed',       varName: '--danger' },
  cancelled: { label: 'cancelled',    varName: '--fg-faint' },
  none:      { label: 'not rendered', varName: '--fg-faint' },
};

// ─── Track ──────────────────────────────────────────────────────────────
//
// Track is not a free choice on every card. Only a hi-fi cell has a generation
// path to pick: fal (Track A) or a handoff (Track B). A lo-fi cell is authored
// as an excalidraw drawing and renders locally off its own content_path
// (registry.ts resolveEngine: '.excalidraw' → the excalidraw adapter); a beat
// sheet is text. Neither has a prompt to send or a clip to hand back, so
// neither is Track A or Track B — they are `local`.

type Track = 'a' | 'b' | 'local';

// ─── Rail nodes ─────────────────────────────────────────────────────────
//
// One node per boarded shot, every rung, in board order, colour-coded by state.
// `next` is the single shot the forge would take next (see `railShots`), NOT a
// guess about the engine's queue.

type RailNodeState = 'idle' | 'done' | 'running' | 'next' | 'handoff' | 'failed';

const RAIL_NODE_STYLE: Record<RailNodeState, React.CSSProperties> = {
  idle: {
    borderColor: 'var(--border)',
    background: 'var(--bg-raised)',
    color: 'var(--fg-faint)',
  },
  done: {
    borderColor: 'var(--live)',
    background: 'color-mix(in oklab, var(--live) 22%, var(--bg-sunken))',
    color: 'var(--live)',
  },
  running: {
    borderColor: 'var(--live)',
    background: 'var(--bg-raised)',
    color: 'var(--live)',
    boxShadow: '0 0 0 3px color-mix(in oklab, var(--live) 18%, transparent)',
  },
  next: {
    borderColor: 'var(--achievement)',
    background: 'var(--bg-raised)',
    color: 'var(--achievement)',
    boxShadow: '0 0 0 3px color-mix(in oklab, var(--achievement) 15%, transparent)',
  },
  handoff: {
    borderColor: 'var(--info)',
    background: 'var(--bg-raised)',
    color: 'var(--info)',
  },
  failed: {
    borderColor: 'var(--danger)',
    background: 'color-mix(in oklab, var(--danger) 22%, var(--bg-sunken))',
    color: 'var(--danger)',
  },
};

function nodeStateFor(tstate: TileState, track: Track, isUpNext: boolean): RailNodeState {
  switch (tstate) {
    case 'rendered':  return 'done';
    case 'rendering': return 'running';
    case 'failed':    return 'failed';
    default:
      // A Track-B shot has no forge to run — it's waiting on a returned clip.
      if (track === 'b') return 'handoff';
      // A local shot is on the board with no forge to run and no clip coming.
      // `idle` (dashed, --border, --fg-faint) already says exactly that.
      if (track === 'local') return 'idle';
      // Only the ONE shot the forge would take next is `next`. Every other
      // queued shot is `idle`: marking them all `next` would make the rail
      // read "3 up next" while a single card carried the badge.
      return isUpNext ? 'next' : 'idle';
  }
}

// ─── Card border accent per state (C's .cell.done/.running/.next/…) ─────

const CARD_ACCENT: Record<RailNodeState, string> = {
  idle:    'border-dashed border-[var(--border)]',
  done:    'border-[color-mix(in_oklab,var(--live)_45%,var(--border))]',
  running: 'border-[var(--live)] shadow-[0_0_0_1px_color-mix(in_oklab,var(--live)_25%,transparent)]',
  next:    'border-[color-mix(in_oklab,var(--achievement)_55%,var(--border))]',
  handoff: 'border-dashed border-[color-mix(in_oklab,var(--info)_45%,var(--border))]',
  failed:  'border-[color-mix(in_oklab,var(--danger)_55%,var(--border))]',
};

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return `${s % 1 === 0 ? s.toFixed(0) : s.toFixed(1)}s`;
}

/** m:ss — the running shot's wall clock since the record's started_at. */
function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'beat';
const rnd = () => Math.random().toString(36).slice(2, 8);

// Project.aspect_ratio → the inner poster frame's box style.
function aspectFrameStyle(aspect: AspectRatio): React.CSSProperties {
  if (aspect === '9:16') return { height: '100%', aspectRatio: '9 / 16' };
  if (aspect === '1:1') return { height: '100%', aspectRatio: '1 / 1' };
  return { width: '100%', height: '100%' };
}

// ─── Focus-trapped modal (add / delete confirm) ─────────────────────────

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const focusables = () =>
      Array.from(
        el.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ),
      ).filter((f) => f.offsetParent !== null);
    (focusables()[0] ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (f.length === 0) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        last.focus();
        e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Portal to <body> so the app-level pane focus-trap doesn't fight this one
  // (the pane trap treats in-pane focusables as its own; body-level escapes it).
  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-[color-mix(in_oklab,var(--bg-sunken)_82%,transparent)] p-4"
      onMouseDown={onClose}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-lg border border-soft bg-surface p-4 text-fg shadow-xl outline-none"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ─── Board shape ────────────────────────────────────────────────────────

/** One boarded cell, any rung, folded with everything the rail and its card both need. */
interface BoardShot {
  item: MockCell;
  /** 1-based rail position across the whole project (all scenes). */
  n: number;
  tstate: TileState;
  track: Track;
  upNext: boolean;
  nodeState: RailNodeState;
}

// `scene_id` is an OTIO id (schema: 'sc3'). Lift the ordinal that is actually in
// the id rather than printing the wire token — but ONLY when it matches the
// documented shape. Any other id is shown verbatim: there is no scene entity and
// no scene name, so an unrecognised id gets echoed, never re-titled.
function sceneTitle(key: string): string {
  if (!key) return 'Storyboard';
  const m = /^sc(\d+)$/i.exec(key);
  return m ? `Scene ${Number(m[1])}` : key;
}

interface SceneGroup {
  key: string;
  title: string;
  shots: BoardShot[];
}

// ─── View ───────────────────────────────────────────────────────────────

export function CanvasView() {
  const selectedCellUid = useSharedStore(selectCellUid);
  const hoverBeat = useSharedStore(selectHoverBeat);
  const playheadMs = useSharedStore(selectPlayheadMs);
  const setCellUid = useSharedStore((s) => s.setCellUid);
  const setHoverBeat = useSharedStore((s) => s.setHoverBeat);

  const project = useProjectStore(selectOpenProject);
  const projectId = project?.project_id ?? null;
  const aspect: AspectRatio = project?.aspect_ratio ?? '16:9';
  const isPortrait = aspect === '9:16';

  // Density is a per-project preference — a vertical-video project and a 16:9
  // explainer want different defaults, and the choice should survive the pane's
  // remount the same way Cell.tsx's draft mirror does.
  const [density, setDensityState] = useState<Density>(() => readDensity(projectId));
  useEffect(() => { setDensityState(readDensity(projectId)); }, [projectId]);
  const setDensity = (d: Density) => {
    setDensityState(d);
    try { localStorage.setItem(densityStorageKey(projectId), d); } catch { /* best-effort */ }
  };
  const isLoupe = density === 'loupe';

  // add/delete cell + error UI — the create/delete busy+error pair rides the
  // shared useAsyncAction (one modal open at a time, so one instance covers both).
  const [addOpen, setAddOpen] = useState(false);
  const [newBeat, setNewBeat] = useState('');
  const [newRung, setNewRung] = useState<Rung>('2_hifi');
  const [confirmDelete, setConfirmDelete] = useState<{ uid: string; beat: string } | null>(null);
  const cellMutation = useAsyncAction();
  const busy = cellMutation.busy;
  const error = cellMutation.error;

  // Cell source: REAL cells hydrated from disk when a real project is open,
  // else the __mocks__/cells.ts fixture for standalone-dev / mock mode.
  const hydratedCells = useStoryboardStore(selectHydratedCells);
  const hasRealCells = useStoryboardStore(selectHasRealCells);
  const projectDoc = useStoryboardStore(selectHydratedProject);
  const renderStatusMap = useStoryboardStore(selectRenderStatus);
  const renderRecords = useStoryboardStore(selectRenderRecords);
  const refreshRenders = useStoryboardStore((s) => s.refreshRenders);
  const bumpActivePoll = useStoryboardStore((s) => s.bumpActivePoll);
  const refetchStoryboard = useStoryboardStore((s) => s.refetch);
  // NOTE (found while closing G-103, deliberately NOT fixed here): this is a
  // PRESENTATION list and its fallback is wider than it reads.
  // `selectHasRealCells` is `source === 'real' && cells.length > 0`, so a REAL
  // project with zero cells (fresh scaffold, or after deleting the last shot)
  // renders the 10-card demo fixture — and the `displayCells.length === 0`
  // EmptyState below can therefore never fire for one. Nothing that WRITES may
  // read this list (see `createCell`'s index note); the display half is a
  // separate defect, it spans the five other views that share the selector, and
  // it wants its own gap id rather than a drive-by change under a canvas fix.
  const displayCells = useMemo<MockCell[]>(
    () => (hasRealCells ? hydratedCells.map(toDisplayCell) : MOCK_CELLS),
    [hasRealCells, hydratedCells],
  );

  // Real per-cell durations (schema field) — surfaced as an honest thumb detail.
  const durationByUid = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of hydratedCells) if (c.duration_ms) m[c.uid] = c.duration_ms;
    return m;
  }, [hydratedCells]);

  // Cross-linking §12 — Composition scrub → playheadMs → Canvas active highlight.
  const scrubClips = useMemo(
    () => (hasRealCells ? buildTimelineModel(hydratedCells, projectDoc, {}).clips : COMPOSITION_TIMELINE),
    [hasRealCells, hydratedCells, projectDoc],
  );
  const activeAtPlayheadUid = clipAt(scrubClips, playheadMs)?.uid ?? null;

  useEffect(() => { void refetchStoryboard(); }, [refetchStoryboard]);

  // ── per-shot generation (gated on Track — hi-fi cells only) ─────────────
  // Anchors resolve id → name/kind for the shot card's ref chips. Shared store
  // (review §2.4) — an unreachable anchor.list just leaves chips showing the
  // raw id, same as the old best-effort local fetch.
  const anchors = useAnchorsStore(selectAnchors);
  const ensureAnchors = useAnchorsStore((s) => s.ensure);
  const refreshAnchors = useAnchorsStore((s) => s.refresh);
  useEffect(() => {
    if (project?.project_id) ensureAnchors(project.project_id);
  }, [project?.project_id, ensureAnchors]);
  const anchorById = useMemo(() => {
    const m: Record<string, Anchor> = {};
    for (const a of anchors) m[a.id] = a;
    return m;
  }, [anchors]);

  // Latest render record per cell — for the status/error/model readout. Prefers
  // the record whose status matches the folded renderStatus (the canonical
  // one per foldRenderStatus's active-wins rule); falls back to the last seen.
  const recordByUid = useMemo(() => {
    const m: Record<string, RenderRecord> = {};
    for (const r of renderRecords) {
      if (!r || typeof r.cell_uid !== 'string' || !r.cell_uid) continue;
      const prev = m[r.cell_uid];
      if (!prev || r.status === renderStatusMap[r.cell_uid]) m[r.cell_uid] = r;
    }
    return m;
  }, [renderRecords, renderStatusMap]);

  // Batched poster prefetch (review §2.5) — one render.list_posters round trip
  // for every done tile's poster instead of N concurrent per-tile
  // render.read_poster calls. Idempotent: prefetchPosters skips ids already
  // cached or already in flight, so this can run on every recordByUid update
  // (the adaptive render poll) without re-fetching what's already resolved.
  const doneRecordIds = useMemo(
    () => Object.values(recordByUid).filter((r) => r.status === 'done' && r.id).map((r) => r.id),
    [recordByUid],
  );
  useEffect(() => {
    if (doneRecordIds.length > 0) prefetchPosters(doneRecordIds);
  }, [doneRecordIds]);

  // Per-cell engine choice — Track A (fal, direct API render) vs Track B
  // (handoff — no API, prompt-package + ingest_external round trip). UI-local:
  // it isn't a persisted Cell field, just which generation path the Generate
  // button takes.
  // '' is Auto and MUST send no variant at all. fal's resolveVideoModel treats
  // ANY variant as a deliberate override that wins over the cell's own
  // metadata.fal_model / FAL_VIDEO_MODEL and suppresses its fromDefault branch
  // — the one that swaps in the image-to-video sibling when the cell has an
  // anchor plate. A picker that always sent its default would silently stop
  // anchors conditioning the shot (or 422 the call). Only an explicit pick
  // may override.
  const FAL_MODEL_AUTO = '';
  const FAL_MODELS = ['ltx-video', 'flux', 'flux-i2v'] as const;
  const HANDOFF_PLATFORMS: PromptPlatform[] = ['higgsfield', 'flow', 'veo', 'generic'];
  interface GenChoice { mode: 'fal' | 'handoff'; model: string; platform: PromptPlatform; }
  const DEFAULT_GEN_CHOICE: GenChoice = { mode: 'fal', model: FAL_MODEL_AUTO, platform: 'higgsfield' };
  const [genChoice, setGenChoiceMap] = useState<Record<string, GenChoice>>({});
  const [genBusy, setGenBusy] = useState<Record<string, boolean>>({});
  const [genError, setGenErrorMap] = useState<Record<string, string>>({});
  const [dropPath, setDropPath] = useState<Record<string, string>>({});
  const [copiedUid, setCopiedUid] = useState<string | null>(null);
  const [collapsedUids, setCollapsedUids] = useState<Set<string>>(() => new Set());
  // G-61 / G-76 #5 — the Rail is the DEFAULT surface until WP-31 verification
  // passes. It carries the real-project hydration, poster prefetch, render
  // beacon, Composition cross-link and create/delete seams that were driven
  // end-to-end against a real project; the node canvas has not been re-cleared
  // against any of them. The plan says "land the canvas BEHIND a view switch
  // first" — WP-28 landed the RAIL behind it instead, so every mount opened the
  // unverified surface and none of the behaviours WP-31 must re-clear were even
  // running. Flipped back: the switch stays, the canvas is opt-in.
  const [canvasMode, setCanvasMode] = useState<'rail' | 'graph'>('rail');

  const toggleCollapse = (uid: string) => {
    setCollapsedUids((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  };

  const choiceFor = (uid: string): GenChoice => genChoice[uid] ?? DEFAULT_GEN_CHOICE;
  const patchChoice = (uid: string, patch: Partial<GenChoice>) =>
    setGenChoiceMap((prev) => ({ ...prev, [uid]: { ...choiceFor(uid), ...patch } }));
  const setGenErrorFor = (uid: string, message: string | null) =>
    setGenErrorMap((prev) => {
      const next = { ...prev };
      if (message) next[uid] = message;
      else delete next[uid];
      return next;
    });

  // ── the board: every cell, every rung, grouped by the script's scenes ───
  //
  // Board order is the order the exporter composes in, so the board shows the
  // film the export actually produces. `rung` is untouched schema.

  // A scene is only ever named by the script's own ScriptBeat.scene_id /
  // shot_id — there is no scene entity to invent a title from, so an unscened
  // storyboard is one flat group rather than a fabricated "Scene 1 — …".
  const sceneByBeatId = useMemo(() => {
    const m: Record<string, string> = {};
    for (const b of projectDoc?.script?.beats ?? []) if (b.scene_id) m[b.id] = b.scene_id;
    return m;
  }, [projectDoc]);
  const shotIdByBeatId = useMemo(() => {
    const m: Record<string, string> = {};
    for (const b of projectDoc?.script?.beats ?? []) if (b.shot_id) m[b.id] = b.shot_id;
    return m;
  }, [projectDoc]);

  // One derivation feeds both the rail and the stage, so a node and the card
  // under it can never disagree about which shot is #4 or what state it's in.
  const board = useMemo<{ scenes: SceneGroup[]; railShots: BoardShot[] }>(() => {
    // Group first — board order IS rail order, so the numbering has to run over
    // the grouped sequence, not the raw cell array.
    const order: string[] = [];
    const byKey = new Map<string, MockCell[]>();
    for (const c of displayCells) {
      const key = sceneByBeatId[c.raw?.beat_id ?? c.beat] ?? '';
      if (!byKey.has(key)) { byKey.set(key, []); order.push(key); }
      byKey.get(key)?.push(c);
    }
    const grouped = order.map((key) => ({ key, cells: byKey.get(key) ?? [] }));
    const flatCells = grouped.flatMap((g) => g.cells);

    // The track is rung-derived, NOT read from genChoice alone: DEFAULT_GEN_CHOICE
    // is fal, so a lower-rung cell would otherwise default to Track A and offer a
    // fal Generate that would send its excalidraw drawing to the network engine.
    const trackFor = (item: MockCell): Track =>
      item.rung !== '2_hifi'
        ? 'local'
        : (genChoice[item.uid] ?? DEFAULT_GEN_CHOICE).mode === 'fal' ? 'a' : 'b';

    const stateOf = (item: MockCell) => {
      const tstate: TileState = hasRealCells
        ? tileStateFor(renderStatusMap[item.uid])
        : item.progress != null && item.progress < 1
          ? 'rendering'
          : 'none';
      return { tstate, track: trackFor(item) };
    };

    // "Up next" — the first Track-A shot that hasn't been forged. One shot, or
    // none. Its uid drives both the gold rail node and the card's corner flag.
    const upNextUid =
      flatCells
        .map((item) => ({ item, ...stateOf(item) }))
        .find((s) => s.track === 'a' && (s.tstate === 'none' || s.tstate === 'queued' || s.tstate === 'cancelled'))
        ?.item.uid ?? null;

    const shotFor = (item: MockCell, n: number): BoardShot => {
      const { tstate, track } = stateOf(item);
      const upNext = item.uid === upNextUid;
      return { item, n, tstate, track, upNext, nodeState: nodeStateFor(tstate, track, upNext) };
    };

    let n = 0;
    const scenes = grouped.map((g) => ({
      key: g.key,
      title: sceneTitle(g.key),
      shots: g.cells.map((item) => shotFor(item, ++n)),
    }));
    return { scenes, railShots: scenes.flatMap((s) => s.shots) };
    // DEFAULT_GEN_CHOICE is a render-local literal; genChoice is the real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayCells, sceneByBeatId, hasRealCells, renderStatusMap, genChoice]);
  const { scenes, railShots } = board;

  // Roving tabindex needs exactly ONE tabbable card at all times, or the board
  // has no keyboard entry point. Cards are `tabIndex={uid === keyboardEntryUid}`,
  // so a uid that matches no card leaves every card at -1 and a keyboard user
  // can never reach a shot. (The deleted Canvas primitive hid this: its
  // container carried `role="application" tabIndex={0}`, so tab always landed
  // somewhere.) `selectedCellUid` is shared cross-view state and routinely names
  // a cell this board does not carry — a cursor restored from a previous session,
  // a cell since deleted, another project's — so it only wins when it is
  // actually ON the board. Otherwise the first shot in board order takes it.
  const keyboardEntryUid = useMemo(() => {
    const onBoard = selectedCellUid && railShots.some((s) => s.item.uid === selectedCellUid);
    return onBoard ? selectedCellUid : (railShots[0]?.item.uid ?? null);
  }, [selectedCellUid, railShots]);

  const railStat = useMemo(() => {
    let done = 0, running = 0, next = 0, failed = 0;
    for (const s of railShots) {
      if (s.nodeState === 'done') done += 1;
      else if (s.nodeState === 'running') running += 1;
      else if (s.nodeState === 'next') next += 1;
      else if (s.nodeState === 'failed') failed += 1;
    }
    return { done, running, next, failed, total: railShots.length };
  }, [railShots]);

  // Wall clock for the running shots' elapsed readout. Only ticks while
  // something is actually rendering — an idle board does no work.
  const anyRendering = railShots.some((s) => s.tstate === 'rendering');
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!anyRendering) return;
    setNowMs(Date.now());
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [anyRendering]);

  // Each leg is counted, never inferred by subtraction: `length - trackACount`
  // would file every local cell under "handoff". The three legs sum to
  // railShots.length, so the strip accounts for the whole board.
  const trackACount = railShots.filter((s) => s.track === 'a').length;
  const trackBCount = railShots.filter((s) => s.track === 'b').length;
  const localCount = railShots.filter((s) => s.track === 'local').length;
  const remainingTrackA = useMemo(
    () => railShots.filter((s) => s.track === 'a' && s.tstate !== 'rendered' && s.tstate !== 'rendering'),
    [railShots],
  );

  // The seed-lock disclosure. Only claims a lock that actually exists: every
  // Track-A shot must carry a seed AND they must all be the same one. Anything
  // else (some pinned, some not; two different seeds) is not a lock, so the
  // line stays off rather than overstating reproducibility.
  const seedLock = useMemo(() => {
    const trackA = railShots.filter((s) => s.track === 'a');
    if (trackA.length === 0) return null;
    const seeds = trackA
      .map((s) => s.item.raw?.seed)
      .filter((s): s is number => typeof s === 'number');
    if (seeds.length !== trackA.length) return null;
    if (new Set(seeds).size !== 1) return null;
    const styleIds = projectDoc?.script?.style_anchors ?? [];
    const styleName = styleIds.length === 1 ? anchorById[styleIds[0]]?.name : undefined;
    return `${styleName ? `${styleName} · ` : ''}seed ${seeds[0]} locked across all Track A shots`;
  }, [railShots, projectDoc, anchorById]);

  // The aspect chip's "~Ns" is the sum of the boarded cells' real duration_ms.
  const boardDurationMs = useMemo(
    () => railShots.reduce((sum, s) => sum + (durationByUid[s.item.uid] ?? 0), 0),
    [railShots, durationByUid],
  );

  // The shared shot-generate pipeline. Canvas drives it per-card (no focused
  // render lifecycle — the storyboard store's adaptive poll refreshes cards),
  // keeping its own per-uid genBusy/genError presentation. The hook owns the
  // engine capability + enqueue + Track-B legs, so the old hardcoded
  // `engine: 'fal'` becomes a resolution against the server's reported matrix.
  const shot = useShotGenerate(selectedCellUid, {
    isReal: hasRealCells,
    projectId: project?.project_id ?? null,
    onEnqueued: () => bumpActivePoll(),
  });

  async function generateShot(uid: string) {
    if (genBusy[uid]) return;
    setGenBusy((prev) => ({ ...prev, [uid]: true }));
    setGenErrorFor(uid, null);
    try {
      // H2 — thread the user's fal model pick (ltx-video / flux / flux-i2v) as
      // the render `variant` (fal's resolveVideoModel reads opts.variant first;
      // Auto must send nothing — see FAL_MODEL_AUTO). The engine is resolved
      // from the shared capability matrix rather than the old 'fal' literal.
      await shot.enqueueRender(uid, {
        engine: shot.resolveTrackAEngineId('fal'),
        variant: choiceFor(uid).model || undefined,
      });
      await Promise.all([refetchStoryboard(), refreshRenders()]);
    } catch (err) {
      setGenErrorFor(uid, `Generate failed — ${(err as Error).message}`);
    } finally {
      setGenBusy((prev) => ({ ...prev, [uid]: false }));
    }
  }

  // Sequential, not Promise.all — each leg refetches the storyboard, and firing
  // N enqueues at once would race those refetches against each other.
  async function forgeAllRemaining() {
    for (const s of remainingTrackA) await generateShot(s.item.uid);
  }

  async function cancelShot(uid: string) {
    const recordId = recordByUid[uid]?.id;
    if (!recordId) return;
    try {
      await shot.cancelRenderJob(recordId);
      await refreshRenders();
    } catch (err) {
      setGenErrorFor(uid, `Cancel failed — ${(err as Error).message}`);
    }
  }

  async function setApproval(uid: string, approved: boolean) {
    try {
      const client = await getMcpClient();
      await storyboardApi.set_approved(client, uid, approved);
      await refetchStoryboard();
    } catch (err) {
      setGenErrorFor(uid, `Couldn't ${approved ? 'approve' : 'reject'} — ${(err as Error).message}`);
    }
  }

  async function copyPromptPackage(uid: string, platform: PromptPlatform) {
    try {
      const pkg = await shot.packagePrompt(uid, { platform });
      const entry = pkg.packages.find((p) => p.cellId === uid) ?? pkg.packages[0];
      if (entry && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(entry.prompt);
      }
      setCopiedUid(uid);
      window.setTimeout(() => setCopiedUid((u) => (u === uid ? null : u)), 2000);
    } catch (err) {
      setGenErrorFor(uid, `Couldn't build the prompt package — ${(err as Error).message}`);
    }
  }

  async function dropClip(uid: string, platform: PromptPlatform) {
    const path = (dropPath[uid] ?? '').trim();
    if (!path || genBusy[uid]) return;
    setGenBusy((prev) => ({ ...prev, [uid]: true }));
    setGenErrorFor(uid, null);
    try {
      await shot.ingestExternal(uid, { filePath: path, engine: platform });
      await Promise.all([refetchStoryboard(), refreshRenders()]);
      setDropPath((prev) => ({ ...prev, [uid]: '' }));
    } catch (err) {
      setGenErrorFor(uid, `Couldn't attach the clip — ${(err as Error).message}`);
    } finally {
      setGenBusy((prev) => ({ ...prev, [uid]: false }));
    }
  }

  async function createCell() {
    if (busy) return;
    const label = newBeat.trim() || 'new beat';
    const beatId = `${slugify(label)}-${rnd()}`;
    const uid = `${beatId}-${rnd()}`;
    // Minimal valid Cell — the sidecar's CellSchema.parse fills the remaining
    // defaults (shot_type, renderer, approved, …). Cast because the inferred
    // Cell type lists those defaulted fields as present.
    const cell = {
      uid,
      beat_id: beatId,
      rung: newRung,
      // G-103 — end-of-lane is ONE piece of arithmetic AND one board, shared
      // with the node canvas's create path.
      //
      // The arithmetic: this was `displayCells.length`, which collides on a
      // board whose indexes run past the cell count (the sidecar's delete does
      // not reindex, so any delete leaves such a gap): with 5 cells at indexes
      // 0,1,2,3,5 it wrote 4 and landed the new shot second-to-last instead of
      // at the end. `nextLaneIndex` = max(maxIndex + 1, length) is correct on
      // both a gapped board and a fresh scaffold (every index 0 there, where
      // max + 1 alone would collide).
      //
      // The board: `hydratedCells`, NOT `displayCells`. `displayCells` falls
      // back to the 10-entry `__mocks__/cells.ts` presentation fixture whenever
      // `hasRealCells` is false — which includes a REAL project with zero cells
      // — so feeding it here re-opened the same divergence one level down: the
      // first cell created on a fresh real board would have been written at
      // `index: 10` while the canvas wrote 0. `hydratedCells` is the array
      // `storyboard.create_cell` actually appends to on both boards (real
      // cells in real mode, the mock MCP's own cells in demo mode), so the two
      // surfaces now agree by construction and not by coincidence.
      index: nextLaneIndex(hydratedCells),
      label,
      time: { start: 0, end: 0 },
      frames: { start: 0, end: 0 },
      content_path: `cells/${rungDir(newRung)}/${uid}/content.html`,
      rungs: {
        '0_beat_sheet': { status: 'pending' },
        '1_lofi': { status: 'pending' },
        '2_hifi': { status: 'pending' },
      },
      last_edited: new Date().toISOString(),
    } as unknown as Cell;
    await cellMutation.run(
      async (client) => {
        await storyboardApi.create_cell(client, cell);
        await refetchStoryboard();
        setCellUid(uid);
        // Open the new cell in the focused pane's Cell view.
        const { focusedPane, setPaneView } = useLayoutStore.getState();
        setPaneView(focusedPane, 'cell');
        setAddOpen(false);
        setNewBeat('');
        setNewRung('2_hifi');
      },
      { onError: (err) => `Couldn't create the cell — ${(err as Error).message}` },
    );
  }

  async function deleteCell(uid: string) {
    if (busy) return;
    await cellMutation.run(
      async (client) => {
        await storyboardApi.delete_cell(client, uid);
        if (selectedCellUid === uid) setCellUid(null);
        await refetchStoryboard();
        setConfirmDelete(null);
      },
      { onError: (err) => `Couldn't delete the cell — ${(err as Error).message}` },
    );
  }

  // Empty-project state — before any cells materialize from an archetype chain.
  if (displayCells.length === 0) {
    return (
      <EmptyState
        glyph="▦"
        title="No cells yet"
        hint="cells materialize from an archetype chain — beatsheet → lofi → hifi"
      >
        <p className="mt-1 max-w-xs text-[11px] leading-relaxed text-fg-faint">
          The agent can scaffold the full grid via chat — try{' '}
          <span className="font-mono text-fg-muted">"storyboard a 30s explainer"</span>.
        </p>
      </EmptyState>
    );
  }

  // Per-shot card. Plain closure fn (not a component) so it shares every
  // handler/selector declared above without re-plumbing props.
  function renderShotCard(s: BoardShot) {
    const { item, tstate, track, nodeState, upNext } = s;
    // MOCK_CELLS carry no authored prompt/anchors/seed (see MockCell.raw) — the
    // generation surface is gated on `raw` so the fixture never gets a Generate
    // button for data it doesn't have.
    const raw = item.raw;
    const choice = choiceFor(item.uid);
    const record = recordByUid[item.uid];
    const busy = genBusy[item.uid] ?? false;
    const shotError = genError[item.uid];
    const isSelected = selectedCellUid === item.uid;
    const hoverLinked = hoverBeat === item.uid;
    const scrubActive = !isSelected && activeAtPlayheadUid === item.uid;
    const sMeta = TILE_STATUS[tstate];
    const dur = durationByUid[item.uid];
    const tint = THUMB_TINT[item.color];
    const failedReason = tstate === 'failed' ? (record?.error ?? shotError) : undefined;
    const mockProgress =
      !hasRealCells && item.progress != null && item.progress < 1 ? item.progress : null;

    const startedAt = record?.started_at ? Date.parse(record.started_at) : NaN;
    const elapsedMs = Number.isFinite(startedAt) ? nowMs - startedAt : null;

    const shotId = (raw && shotIdByBeatId[raw.beat_id]) || item.uid;

    // Status line — the specific reason, never a bare "failed". No money: the
    // right-hand slot carries the seed for a Track-A shot, and nothing at all
    // for Track B or a local one (no fal seed exists for either).
    const statusLabel =
      tstate === 'rendered'
        ? 'Done'
        : tstate === 'rendering'
          ? elapsedMs != null ? `Running · ${fmtElapsed(elapsedMs)}` : 'Running'
          : tstate === 'queued'
            ? 'Queued'
            : tstate === 'failed'
              ? `Failed — ${failedReason ?? 'reason not reported'}`
              : tstate === 'cancelled'
                ? 'Cancelled'
                : track === 'a'
                  ? 'Not started'
                  : track === 'b'
                    ? 'Awaiting clip'
                    : 'Not rendered';
    const statusVar = nodeState === 'handoff' ? '--info' : sMeta.varName;

    const openInCellView = () => {
      setCellUid(item.uid);
      const { focusedPane, setPaneView } = useLayoutStore.getState();
      setPaneView(focusedPane, 'cell');
    };

    const isCollapsed = collapsedUids.has(item.uid);

    if (isCollapsed) {
      return (
        <article
          key={item.uid}
          role="button"
          data-state={nodeState}
          data-track={track}
          data-rung={item.rung}
          tabIndex={item.uid === keyboardEntryUid ? 0 : -1}
          onClick={() => setCellUid(item.uid)}
          className={[
            'cell-card group relative flex items-center justify-between gap-2 rounded border bg-surface px-2.5 py-1.5 text-left transition-shadow hover:shadow',
            isLoupe ? 'w-full' : 'w-[198px] shrink-0',
            CARD_ACCENT[nodeState],
            isSelected ? 'outline-2 outline outline-offset-2 outline-[var(--achievement)]' : '',
          ].join(' ')}
          style={{
            borderTopWidth: 2,
            borderTopColor: `var(${track === 'a' ? '--agent' : track === 'b' ? '--info' : '--fg-faint'})`,
          }}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              aria-label="Expand shot card"
              onClick={(e) => { e.stopPropagation(); toggleCollapse(item.uid); }}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] text-fg-faint hover:bg-raised hover:text-fg"
            >
              ▸
            </button>
            <span className="font-mono text-[9px] tabular-nums text-fg-faint">
              {String(s.n).padStart(2, '0')}
            </span>
            <span className="truncate font-mono text-[9.5px] uppercase tracking-wider text-fg" title={item.uid}>
              {shotId}
            </span>
            {RUNG_CHIP[item.rung] && (
              <span className="shrink-0 rounded-sm border border-soft bg-raised px-1 py-px font-mono text-[8px] uppercase tracking-wider text-fg-muted">
                {RUNG_CHIP[item.rung]}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5 font-mono text-[9px]">
            <span style={{ color: `var(${statusVar})` }}>
              {tstate === 'rendered' ? '✓' : tstate === 'failed' ? '✕' : <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: `var(${statusVar})` }} />}
            </span>
            {dur != null && <span className="tabular-nums text-fg-faint">{fmtDuration(dur)}</span>}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); openInCellView(); }}
              className="hidden rounded border border-soft px-1 py-0.5 text-[8.5px] text-fg-muted hover:text-fg group-hover:block"
              title="Open in Cell View"
            >
              Open
            </button>
          </div>
        </article>
      );
    }

    return (
      <article
        key={item.uid}
        role="button"
        data-state={nodeState}
        data-track={track}
        data-rung={item.rung}
        data-up-next={upNext ? 'true' : undefined}
        tabIndex={item.uid === keyboardEntryUid ? 0 : -1}
        onMouseEnter={() => setHoverBeat(item.uid)}
        onMouseLeave={() => setHoverBeat(null)}
        onClick={() => setCellUid(item.uid)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setCellUid(item.uid);
          }
        }}
        className={[
          'cell-card group relative flex flex-col rounded-md border bg-surface text-left transition-shadow hover:shadow-lg',
          isLoupe ? 'w-full' : 'w-[198px] shrink-0',
          CARD_ACCENT[nodeState],
          isSelected
            ? 'outline-2 outline outline-offset-2 outline-[var(--achievement)]'
            : scrubActive
              ? 'outline-2 outline outline-offset-2 outline-[var(--info)]'
              : '',
          hoverLinked ? ' is-hover-link' : '',
        ].join(' ')}
        style={{
          borderTopWidth: 2,
          // Neutral for a local shot — the stripe must not claim a track.
          borderTopColor: `var(${track === 'a' ? '--agent' : track === 'b' ? '--info' : '--fg-faint'})`,
        }}
      >
        {upNext && (
          <span className="absolute -top-2 right-2 z-10 rounded-sm bg-[var(--achievement)] px-1.5 py-px font-mono text-[8px] font-semibold uppercase tracking-wider text-[var(--bg-base)]">
            Up next
          </span>
        )}

        {/* delete (hover / focus revealed) — real storyboard.delete_cell.
            G-102: the name carries the uid, through the SAME helper the node
            canvas uses. `item.beat` alone is not unique on a real board — all
            five cells on the WP-32 fixture read `beat-hello`, so this button
            rendered five times with the identical accessible name, on the
            DEFAULT view (`canvasMode` starts at 'rail'). `title` takes the same
            string because the hover tooltip is the only identification a
            sighted pointer user gets from a ✕ that is revealed on hover. */}
        <button
          type="button"
          aria-label={deleteCellControlName(item)}
          title={deleteCellControlName(item)}
          onClick={(e) => {
            e.stopPropagation();
            cellMutation.clearError();
            setConfirmDelete({ uid: item.uid, beat: item.beat });
          }}
          className="absolute right-1 top-1 z-10 hidden h-5 w-5 items-center justify-center rounded border border-[var(--border)] bg-surface text-[11px] leading-none text-fg-faint hover:border-[var(--danger)] hover:text-[var(--danger)] group-hover:flex focus-visible:flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--danger)_45%,transparent)]"
        >
          <span aria-hidden>✕</span>
        </button>

        {/* tag — rail position / shot id / shot type / track */}
        <div
          className={[
            'flex items-center justify-between gap-1.5 px-2.5',
            isLoupe ? 'border-b border-soft py-2' : 'pb-1 pt-2',
          ].join(' ')}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              aria-label="Collapse shot card"
              onClick={(e) => { e.stopPropagation(); toggleCollapse(item.uid); }}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] text-fg-faint hover:bg-raised hover:text-fg"
            >
              ▾
            </button>
            <span className="font-mono text-[9px] tabular-nums text-fg-faint">
              {String(s.n).padStart(2, '0')}
            </span>
            <span
              className={[
                'truncate font-mono uppercase tracking-wider text-fg-muted',
                isLoupe ? 'text-[11px]' : 'text-[9.5px]',
              ].join(' ')}
              title={item.uid}
            >
              {shotId}
            </span>
            {raw?.shot_type && raw.shot_type !== 'unset' && (
              <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-fg-faint">
                {raw.shot_type}
              </span>
            )}
            {RUNG_CHIP[item.rung] && (
              <span className="shrink-0 rounded-sm border border-soft bg-raised px-1 py-px font-mono text-[8.5px] uppercase tracking-wider text-fg-muted">
                {RUNG_CHIP[item.rung]}
              </span>
            )}
          </span>
          <span
            aria-label={track === 'a' ? 'Track A' : track === 'b' ? 'Track B' : 'Local render'}
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: `var(${track === 'a' ? '--agent' : track === 'b' ? '--info' : '--fg-faint'})` }}
          />
        </div>

        {/* poster — done cells overlay a real frame (bytes-over-bridge); the rest
            keep the beat tint + an honest status glyph. */}
        <div
          className={[
            'relative mx-2.5 flex items-center justify-center overflow-hidden rounded-sm border border-soft bg-sunken',
            isLoupe ? 'aspect-[16/9]' : 'h-[98px]',
          ].join(' ')}
        >
          <div
            className={['relative flex items-center justify-center overflow-hidden', tint].join(' ')}
            style={aspectFrameStyle(aspect)}
          >
            {tstate === 'rendered' && record?.id ? (
              <CellPoster
                recordId={record.id}
                alt={item.beat}
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : null}
            {/* forge glow — the ember cast a poster-less card still deserves */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  'radial-gradient(circle at 30% 115%, color-mix(in oklab, var(--achievement) 22%, transparent), transparent 60%)',
                opacity: tstate === 'none' ? 0.4 : 1,
              }}
            />
            <span
              className="relative z-[1] flex items-center gap-1 font-mono text-[9px]"
              style={{ color: `var(${sMeta.varName})` }}
            >
              {tstate === 'rendered' ? (
                <span aria-hidden>✓</span>
              ) : tstate === 'failed' ? (
                <span aria-hidden>✕</span>
              ) : (
                <span
                  className={'h-1.5 w-1.5 rounded-full' + (tstate === 'rendering' ? ' animate-pulse' : '')}
                  style={{ background: `var(${sMeta.varName})` }}
                />
              )}
              {sMeta.label}
            </span>
            {isPortrait && <SafeZoneBands />}
            {mockProgress != null && (
              <div className="absolute inset-x-0 bottom-0 h-0.5 bg-[var(--bg-sunken)]">
                <div className="h-full bg-[var(--info)]" style={{ width: `${mockProgress * 100}%` }} />
              </div>
            )}
          </div>
          {dur != null && (
            <span className="absolute right-1.5 top-1.5 z-[1] font-mono text-[8.5px] tabular-nums text-fg-faint">
              {fmtDuration(dur)}
            </span>
          )}
          {mockProgress != null && (
            <div className="absolute left-1.5 top-1.5 flex items-center gap-1 font-mono text-[9px] text-[var(--info)]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--info)]" />
              {Math.round(mockProgress * 100)}%
            </div>
          )}
          {isPortrait && (
            <span className="absolute bottom-1 left-1 rounded border border-[var(--beat-accent-sky-border)] bg-[var(--beat-accent-sky-soft)] px-1 py-px font-mono text-[7px] uppercase tracking-wider text-[var(--info)]">
              9:16
            </span>
          )}
        </div>

        <div className="flex flex-1 flex-col gap-2 px-2.5 pb-2.5 pt-2">
          {/* beat + approved badge */}
          <div className="flex items-center justify-between gap-1">
            <span
              className={['truncate font-medium text-fg', isLoupe ? 'text-[12.5px]' : 'text-[11px]'].join(' ')}
            >
              {item.beat}
            </span>
            {item.approved && (
              <span aria-label="approved" className="font-mono text-[10px] text-[var(--live)]">
                ✓
              </span>
            )}
          </div>

          {raw?.prompt && (
            <p
              className={[
                'text-fg-muted',
                isLoupe ? 'text-[12px] leading-relaxed' : 'truncate text-[10px]',
              ].join(' ')}
              title={raw.prompt}
            >
              {raw.prompt}
            </p>
          )}

          {/* anchor-ref chips */}
          {raw && raw.anchors.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {raw.anchors.map((aid) => {
                const a = anchorById[aid];
                const dotVar =
                  a?.kind === 'character' ? '--agent' : a?.kind === 'location' ? '--info' : '--fg-faint';
                return (
                  <span
                    key={aid}
                    className={[
                      'flex items-center gap-1 border border-soft bg-raised font-mono text-fg-muted',
                      isLoupe ? 'rounded-full px-2 py-0.5 text-[10px]' : 'rounded-sm px-1.5 py-px text-[9px]',
                    ].join(' ')}
                    title={aid}
                  >
                    <span className="h-1 w-1 rounded-full" style={{ background: `var(${dotVar})` }} />
                    {a?.name ?? aid}
                  </span>
                );
              })}
            </div>
          )}

          {raw && (
            <>
              {/* engine picker — Track A (fal, direct render) vs Track B (handoff,
                  no API). A local shot has nothing to pick: resolveEngine derives
                  its engine from content_path, and there is no fal model and no
                  handoff platform. */}
              {track !== 'local' && (
              <div
                className={[
                  'flex items-center gap-1 rounded border px-1 py-0.5',
                  track === 'a'
                    ? 'border-[color-mix(in_oklab,var(--agent)_40%,var(--border))] bg-[color-mix(in_oklab,var(--agent)_12%,var(--bg-raised))]'
                    : 'border-dashed border-[color-mix(in_oklab,var(--info)_40%,var(--border))] bg-[color-mix(in_oklab,var(--info)_10%,var(--bg-raised))]',
                ].join(' ')}
              >
                <select
                  value={choice.mode}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => patchChoice(item.uid, { mode: e.target.value as GenChoice['mode'] })}
                  className={[
                    'rounded border-none bg-transparent py-0.5 font-mono text-fg outline-none',
                    isLoupe ? 'text-[11px]' : 'text-[9.5px]',
                  ].join(' ')}
                  aria-label="Generation path"
                >
                  <option value="fal">fal</option>
                  <option value="handoff">handoff</option>
                </select>
                <span className="text-fg-faint" aria-hidden>▸</span>
                {track === 'a' ? (
                  <select
                    value={choice.model}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => patchChoice(item.uid, { model: e.target.value })}
                    className={[
                      'min-w-0 flex-1 rounded border-none bg-transparent py-0.5 font-mono text-fg outline-none',
                      isLoupe ? 'text-[11px]' : 'text-[9.5px]',
                    ].join(' ')}
                    aria-label="fal model"
                    title={
                      choice.model
                        ? `Pinned to ${choice.model} — overrides this cell's own model setting, and an attached anchor will not switch it to image-to-video.`
                        : "Auto — uses this cell's own model setting if it has one, and otherwise switches to image-to-video when an anchor is attached."
                    }
                  >
                    <option value={FAL_MODEL_AUTO}>auto · i2v if anchored</option>
                    {FAL_MODELS.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                ) : (
                  <select
                    value={choice.platform}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => patchChoice(item.uid, { platform: e.target.value as PromptPlatform })}
                    className={[
                      'min-w-0 flex-1 rounded border-none bg-transparent py-0.5 font-mono text-fg outline-none',
                      isLoupe ? 'text-[11px]' : 'text-[9.5px]',
                    ].join(' ')}
                    aria-label="Handoff platform"
                  >
                    {HANDOFF_PLATFORMS.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                )}
              </div>
              )}

              {/* status row — the specific reason + seed. No cost: fal reports
                  none for these models, so there is no honest figure to show. */}
              <div
                className={[
                  'flex items-center justify-between gap-2 font-mono',
                  isLoupe ? 'text-[10.5px]' : 'text-[9.5px]',
                ].join(' ')}
              >
                <span
                  className={[
                    'flex min-w-0 items-center gap-1.5 uppercase tracking-wider',
                    isLoupe ? 'rounded-full border border-soft bg-raised px-2 py-0.5' : '',
                  ].join(' ')}
                  style={{ color: `var(${statusVar})` }}
                  title={statusLabel}
                >
                  <span
                    className={
                      'h-1.5 w-1.5 shrink-0 rounded-full' +
                      (tstate === 'rendering' ? ' animate-pulse' : '')
                    }
                    style={{ background: `var(${statusVar})` }}
                  />
                  <span className="truncate">{statusLabel}</span>
                </span>
                {track === 'a' && raw.seed != null && (
                  <span className="shrink-0 tabular-nums text-fg-faint">seed {raw.seed}</span>
                )}
              </div>

              {/* actions — a local shot renders off its own content_path, so it
                  gets neither a fal Generate it cannot honour nor a drop zone for
                  a clip nobody is returning. */}
              {track !== 'local' && (
              <div className="flex flex-col gap-1">
                {track === 'a' ? (
                  tstate === 'rendering' ? (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); void cancelShot(item.uid); }}
                      className="rounded border border-[color-mix(in_oklab,var(--danger)_45%,var(--border))] bg-raised px-2 py-1 text-[10px] text-[var(--danger)] hover:bg-sunken"
                    >
                      Cancel
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={(e) => { e.stopPropagation(); void generateShot(item.uid); }}
                      className={[
                        'rounded px-2 py-1 text-[10px] font-medium disabled:opacity-50',
                        tstate === 'rendered' || tstate === 'failed'
                          ? 'border border-soft bg-raised text-fg hover:bg-sunken'
                          : 'bg-[var(--achievement)] text-[var(--bg-base)]',
                      ].join(' ')}
                    >
                      {busy
                        ? 'Queuing…'
                        : tstate === 'rendered'
                          ? 'Regenerate'
                          : tstate === 'failed'
                            ? 'Retry'
                            : 'Generate'}
                    </button>
                  )
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); void copyPromptPackage(item.uid, choice.platform); }}
                      className="rounded border border-[color-mix(in_oklab,var(--info)_45%,var(--border))] bg-[color-mix(in_oklab,var(--info)_12%,var(--bg-raised))] px-2 py-1 text-[10px] text-[var(--info)] hover:bg-sunken"
                    >
                      {copiedUid === item.uid ? 'Copied ✓' : 'Copy prompt package'}
                    </button>
                    {/* Track B has no API to poll — the clip comes back by hand. */}
                    <div className="rounded-sm border border-dashed border-[var(--border)] p-1.5">
                      <p className="text-center font-mono text-[8.5px] uppercase tracking-wider text-fg-faint">
                        Drop returned .mp4 here
                      </p>
                      <div className="mt-1 flex gap-1">
                        <input
                          type="text"
                          value={dropPath[item.uid] ?? ''}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setDropPath((prev) => ({ ...prev, [item.uid]: e.target.value }))}
                          placeholder="returned clip path…"
                          className="min-w-0 flex-1 rounded border border-soft bg-sunken px-1.5 py-1 font-mono text-[9.5px] text-fg outline-none focus:border-[var(--info)]"
                        />
                        <button
                          type="button"
                          disabled={busy || !(dropPath[item.uid] ?? '').trim()}
                          onClick={(e) => { e.stopPropagation(); void dropClip(item.uid, choice.platform); }}
                          className="shrink-0 rounded border border-soft bg-raised px-2 py-1 text-[10px] text-fg hover:bg-sunken disabled:opacity-50"
                        >
                          Attach
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
              )}

              {/* approve / reject */}
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); void setApproval(item.uid, true); }}
                  className={[
                    'flex-1 rounded border px-2 py-0.5 text-[10px]',
                    raw.approved
                      ? 'border-[var(--live)] bg-[color-mix(in_oklab,var(--live)_16%,var(--bg-raised))] text-[var(--live)]'
                      : 'border-soft bg-raised text-fg-muted hover:text-fg',
                  ].join(' ')}
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); void setApproval(item.uid, false); }}
                  className="flex-1 rounded border border-soft bg-raised px-2 py-0.5 text-[10px] text-fg-muted hover:text-[var(--danger)]"
                >
                  Reject
                </button>
              </div>

              {/* failed reason + retry / edit prompt */}
              {failedReason && (
                <div className="rounded border border-dashed border-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_10%,var(--bg-sunken))] px-1.5 py-1 text-[10px] text-[var(--danger)]">
                  <p className="truncate" title={failedReason}>{failedReason}</p>
                  <div className="mt-1 flex gap-1">
                    {/* Retry goes through generateShot → fal. For a local shot a
                        failure means its excalidraw render failed, and retrying
                        would re-route the drawing to the network engine. */}
                    {track !== 'local' && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); void generateShot(item.uid); }}
                        className="rounded border border-[var(--danger)] px-1.5 py-0.5 text-[9.5px] text-[var(--danger)] hover:bg-[color-mix(in_oklab,var(--danger)_18%,transparent)]"
                      >
                        Retry
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); openInCellView(); }}
                      className="rounded border border-soft px-1.5 py-0.5 text-[9.5px] text-fg-muted hover:text-fg"
                    >
                      Edit prompt
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </article>
    );
  }

  return (
    <section
      className="relative flex h-full flex-col bg-base text-fg"
      data-canvas-density={density}
    >
      {/* Head — project crumb + aspect chip / density / anchors + forge-all. */}
      <header className="flex items-center justify-between gap-3 border-b border-soft bg-surface px-3 py-1.5 text-[11px]">
        <div className="flex min-w-0 items-center gap-2 text-fg-muted">
          <span className="truncate font-mono">{project?.name ? `~/${project.name}/` : '~/Projects/'}</span>
          <span className="rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--achievement)] ring-1 ring-inset ring-[color-mix(in_oklab,var(--achievement)_40%,transparent)]">
            studio
          </span>
          <span className="text-fg-faint">·</span>
          <span className="text-fg-faint">archetype</span>
          <span className="font-mono text-fg">{project?.archetype_id ?? '—'}</span>
          <span
            className="ml-1 rounded-sm border border-soft px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-fg-muted"
            title="Output framing · boarded duration · shot count"
          >
            {aspect}
            {boardDurationMs > 0 && ` · ~${fmtDuration(boardDurationMs)}`}
            {` · ${railShots.length} shot${railShots.length === 1 ? '' : 's'}`}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {/* Surface view switcher: Node Canvas (Graph) vs 1D Rail (G-61) */}
          <div
            role="tablist"
            aria-label="Canvas mode"
            className="flex gap-0.5 rounded-md border border-soft bg-sunken p-0.5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={canvasMode === 'graph'}
              onClick={() => setCanvasMode('graph')}
              className={
                'rounded px-2 py-0.5 text-[11px] ' +
                (canvasMode === 'graph'
                  ? 'bg-raised text-fg ring-1 ring-inset ring-[var(--border-soft)]'
                  : 'text-fg-muted hover:text-fg')
              }
            >
              Canvas
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={canvasMode === 'rail'}
              onClick={() => setCanvasMode('rail')}
              className={
                'rounded px-2 py-0.5 text-[11px] ' +
                (canvasMode === 'rail'
                  ? 'bg-raised text-fg ring-1 ring-inset ring-[var(--border-soft)]'
                  : 'text-fg-muted hover:text-fg')
              }
            >
              Rail
            </button>
          </div>

          {/* Density — the shell's grid/loupe idiom, per project. */}
          <div
            role="tablist"
            aria-label="Card density"
            className="flex gap-0.5 rounded-md border border-soft bg-sunken p-0.5"
          >
            {(['strip', 'loupe'] as const).map((d) => (
              <button
                key={d}
                type="button"
                role="tab"
                aria-selected={density === d}
                onClick={() => setDensity(d)}
                className={
                  'rounded px-2 py-0.5 text-[11px] capitalize ' +
                  (density === d
                    ? 'bg-raised text-fg ring-1 ring-inset ring-[var(--border-soft)]'
                    : 'text-fg-muted hover:text-fg')
                }
              >
                {d}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              if (collapsedUids.size === railShots.length) {
                setCollapsedUids(new Set());
              } else {
                setCollapsedUids(new Set(railShots.map((s) => s.item.uid)));
              }
            }}
            className="rounded border border-[var(--border)] px-2 py-1 font-mono text-[10px] text-fg-muted hover:border-[var(--fg-faint)] hover:text-fg"
            title={collapsedUids.size === railShots.length ? 'Expand all shot cards' : 'Collapse all shot cards'}
          >
            {collapsedUids.size === railShots.length ? '▾ Expand all' : '▸ Collapse all'}
          </button>
          <button
            type="button"
            onClick={() => void refreshAnchors()}
            className="rounded border border-[var(--border)] px-2 py-1 text-fg-muted hover:border-[var(--fg-faint)] hover:text-fg"
          >
            Refresh anchors
          </button>
          <button
            type="button"
            onClick={() => { cellMutation.clearError(); setAddOpen(true); }}
            className="rounded px-2 py-1 text-fg-muted hover:bg-raised hover:text-fg"
          >
            + New cell
          </button>
          <button
            type="button"
            disabled={remainingTrackA.length === 0}
            onClick={() => void forgeAllRemaining()}
            title="Enqueue every Track-A shot that isn't already forged or running"
            className="rounded border border-[color-mix(in_oklab,var(--achievement)_60%,transparent)] bg-[color-mix(in_oklab,var(--achievement)_18%,transparent)] px-3 py-1 text-[12px] font-medium text-[var(--achievement)] shadow-[0_0_0_1px_color-mix(in_oklab,var(--achievement)_18%,transparent)] hover:bg-[color-mix(in_oklab,var(--achievement)_26%,transparent)] disabled:opacity-40"
          >
            Forge all remaining · {remainingTrackA.length} shot{remainingTrackA.length === 1 ? '' : 's'}
          </button>
        </div>
      </header>

      {/* Error banner — real MCP create/delete failures surface here. */}
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 border-b border-[var(--beat-accent-rose-border,var(--danger))] bg-[color-mix(in_oklab,var(--danger)_12%,var(--bg-sunken))] px-3 py-1.5 text-[11px] text-[var(--danger)]"
        >
          <span className="truncate">{error}</span>
          <button
            type="button"
            onClick={() => cellMutation.clearError()}
            className="rounded px-1.5 py-0.5 text-fg-muted hover:bg-raised hover:text-fg"
          >
            Dismiss
          </button>
        </div>
      )}

      {canvasMode === 'graph' ? (
        <div className="min-h-0 flex-1">
          <NodeCanvas />
        </div>
      ) : (
        <>
      {/* The Rail — project-wide forge progress. One node per boarded shot, in
          board order; a projection of `railShots`, never a second source. */}
      <div className="shrink-0 border-b border-soft bg-surface px-6 py-3">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <span className="font-mono text-[10.5px] uppercase tracking-wider text-fg-faint">
            The Rail — forge progress
          </span>
          <span className="font-mono text-[11px] tabular-nums text-fg-muted">
            <b className="font-medium text-[var(--achievement)]">{railStat.done}</b> / {railStat.total} forged
            {' · '}
            <b className="font-medium text-fg">{railStat.running}</b> running
            {' · '}
            <b className="font-medium text-fg">{railStat.next}</b> up next
            {' · '}
            <b className="font-medium text-fg">{railStat.failed}</b> failed
          </span>
        </div>
        <div className="relative h-2.5 rounded-full border border-soft bg-sunken">
          <div
            className="absolute inset-y-0 left-0 rounded-l-full"
            style={{
              width: `${railStat.total > 0 ? (railStat.done / railStat.total) * 100 : 0}%`,
              background:
                'linear-gradient(90deg, color-mix(in oklab, var(--achievement) 40%, var(--bg-sunken)), var(--achievement))',
              boxShadow: '0 0 12px 0 color-mix(in oklab, var(--achievement) 50%, transparent)',
            }}
          />
          <div className="absolute inset-0 flex">
            {railShots.map((s) => (
              <div key={s.item.uid} className="relative flex-1">
                <button
                  type="button"
                  aria-label={`Shot ${s.n} — ${s.item.beat} — ${s.nodeState}`}
                  onClick={() => setCellUid(s.item.uid)}
                  onMouseEnter={() => setHoverBeat(s.item.uid)}
                  onMouseLeave={() => setHoverBeat(null)}
                  className={
                    'absolute left-0 top-1/2 z-[2] flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 font-mono text-[8.5px] tabular-nums' +
                    (s.nodeState === 'running' ? ' animate-pulse' : '')
                  }
                  style={RAIL_NODE_STYLE[s.nodeState]}
                >
                  {s.n}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Stage — document flow. No pan, no zoom, no free placement. Clicking the
          bare stage clears the shared selection (the old canvas primitive did
          this via onSelectionChange(null)). */}
      <main
        className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
        onClick={(e) => { if (e.target === e.currentTarget) setCellUid(null); }}
      >
        {scenes.map((scene) => (
          <section key={scene.key || '__flat'} className="mb-6 last:mb-0">
            <header className="mb-3 flex items-baseline gap-2 border-b border-soft pb-1.5">
              <h2 className="font-display text-[16px] font-medium text-fg" title={scene.key || undefined}>
                {scene.title}
              </h2>
              <span className="font-mono text-[11px] text-fg-muted">
                {scene.shots.length} cell{scene.shots.length === 1 ? '' : 's'}
              </span>
            </header>
            <div
              className={
                isLoupe
                  ? 'grid grid-cols-1 gap-3.5 xl:grid-cols-2'
                  : 'flex flex-wrap items-start gap-3.5'
              }
            >
              {scene.shots.map((s) => renderShotCard(s))}
            </div>
          </section>
        ))}
      </main>

      {/* Ledger strip — track split + the seed-lock disclosure. No spend: fal
          reports no cost for these models, and the Ledger view owns that column
          if it ever does. */}
      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-soft bg-surface px-6 py-2 font-mono text-[10.5px] text-fg-muted">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--agent)]" />
            Track A · fal generation <b className="font-medium tabular-nums text-fg">{trackACount} shot{trackACount === 1 ? '' : 's'}</b>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--info)]" />
            Track B · handoff <b className="font-medium tabular-nums text-fg">{trackBCount} shot{trackBCount === 1 ? '' : 's'}</b>
          </span>
          {localCount > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--fg-faint)]" />
              Local · drawn <b className="font-medium tabular-nums text-fg">{localCount} shot{localCount === 1 ? '' : 's'}</b>
            </span>
          )}
        </div>
        {seedLock && <div className="truncate text-fg-faint">{seedLock}</div>}
      </footer>
      </>
      )}

      {/* New cell dialog */}
      {addOpen && (
        <Modal title="New cell" onClose={() => setAddOpen(false)}>
          <h2 className="font-display text-sm font-semibold">New cell</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">
            Adds an empty cell to the storyboard at the chosen rung, then opens it in the Cell view.
          </p>
          <label className="mt-3 block text-[11px] text-fg-muted">
            Beat label
            <input
              type="text"
              value={newBeat}
              onChange={(e) => setNewBeat(e.target.value)}
              placeholder="e.g. hook"
              className="mt-1 w-full rounded border border-soft bg-sunken px-2 py-1 font-mono text-[12px] text-fg outline-none focus:border-[var(--info)]"
            />
          </label>
          <label className="mt-3 block text-[11px] text-fg-muted">
            Rung
            <select
              value={newRung}
              onChange={(e) => setNewRung(e.target.value as Rung)}
              className="mt-1 w-full rounded border border-soft bg-sunken px-2 py-1 font-mono text-[12px] text-fg outline-none focus:border-[var(--info)]"
            >
              <option value="0_beat_sheet">beat sheet</option>
              <option value="1_lofi">lo-fi</option>
              <option value="2_hifi">hi-fi</option>
            </select>
          </label>
          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setAddOpen(false)}
              className="rounded px-2.5 py-1 text-[11px] text-fg-muted hover:bg-raised hover:text-fg"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void createCell()}
              className="rounded bg-[color-mix(in_oklab,var(--achievement)_22%,transparent)] px-2.5 py-1 text-[11px] text-[var(--achievement)] ring-1 ring-inset ring-[color-mix(in_oklab,var(--achievement)_40%,transparent)] hover:bg-[color-mix(in_oklab,var(--achievement)_30%,transparent)] disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create cell'}
            </button>
          </div>
        </Modal>
      )}

      {/* Delete confirm */}
      {confirmDelete && (
        <Modal title="Delete cell" onClose={() => setConfirmDelete(null)}>
          <h2 className="font-display text-sm font-semibold">Delete this cell?</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">
            <span className="font-mono text-fg">{confirmDelete.beat}</span>{' '}
            <span className="font-mono text-fg-faint">({confirmDelete.uid})</span> will be removed
            from the storyboard. Its render files on disk are left in place.
          </p>
          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmDelete(null)}
              className="rounded px-2.5 py-1 text-[11px] text-fg-muted hover:bg-raised hover:text-fg"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void deleteCell(confirmDelete.uid)}
              className="rounded bg-[color-mix(in_oklab,var(--danger)_18%,transparent)] px-2.5 py-1 text-[11px] text-[var(--danger)] ring-1 ring-inset ring-[color-mix(in_oklab,var(--danger)_40%,transparent)] hover:bg-[color-mix(in_oklab,var(--danger)_26%,transparent)] disabled:opacity-50"
            >
              {busy ? 'Deleting…' : 'Delete cell'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
