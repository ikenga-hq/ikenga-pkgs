/**
 * Node Canvas view (WP-28 · WP-29 · WP-30, Plan 25) — behind the view switch.
 *
 * A pan/zoom canvas of heterogeneous, expandable nodes projecting the on-disk
 * project: pipeline stages, the script, its beats, the boarded shots, and the
 * anchors they reference. The canvas is a PROJECTION, not a document: project
 * files are the truth, the canvas renders them and offers actions back.
 *
 * ─── What this file implements ────────────────────────────────────────────
 * - Authored state lives in `<project>/.studio/canvas.json`, through the
 *   `canvas.read` / `canvas.write` RPCs — never localStorage (invisible to the
 *   watcher and to a second machine) and never `storyboard.json` (an agent
 *   rewrite would wipe it). localStorage survives ONLY as the off-shell /
 *   standalone-dev fallback, where there is no project on disk at all.
 * - D-25-1: `group` is the only true container. Stage relationships are an
 *   edge + a chip on the shot; stages never own shots.
 * - D-25-2: orphan reconciliation is LAZY — a placement whose cell vanished is
 *   tombstoned, and only swept at project open past the grace window. Nothing
 *   is pruned on a cells refetch, so an agent mid-rewrite cannot scatter the
 *   arrangement.
 * - D-25-3: at most 2 live srcdoc panes; no media below the LOD threshold.
 * - D-25-5: shots default into a sequence lane derived from `Cell.index`; an
 *   in-lane drop writes `Cell.index` through `storyboard.reorder_cells`; free
 *   placement is non-semantic and a broken-out shot draws a tether back to its
 *   lane slot. The lane collapses to a strip.
 * - G-57: beat → shot edges derive from the `[[tags]]` in `script.fountain`,
 *   keyed by uid, through the SAME `../lib/tag-linking` module the Breakdown
 *   rail uses. The `beat_id` FK is not consulted — it is null on every real
 *   project, which is the whole point of the gap.
 * - G-58: free placement never writes `Cell.index`.
 *
 * ─── What this file deliberately does NOT do yet ──────────────────────────
 * - Rendering-ladder row 2 (expanded → `<video>` via `render.read_bytes`) is
 *   not here; the Cell and Composition views own real playback, and G-59 says
 *   an expanded node must not reimplement the Cell view. Collapsed tiles show
 *   a poster, expanded un-rendered ones a live draft, and that is the whole
 *   ladder this surface claims.
 * - The plan's per-kind ACTIONS table (breakdown.run / anchor.generate /
 *   render / retry / export.compose) is not wired. This canvas mutates
 *   `storyboard.json` through exactly THREE seams and no others — the lane
 *   reorder (`storyboard.reorder_cells`), and G-61 b5's create / delete
 *   (`storyboard.create_cell` / `storyboard.delete_cell`), both of which are
 *   the Rail's RPCs called unchanged. Everything else it writes is its own
 *   layout in `.studio/canvas.json`. If you are auditing which surfaces can
 *   remove a shot, this one can.
 * - D-25-4's stage rollup ships only its uncontroversial half (counts primary,
 *   a failed member promotes a warning). The founder decision is still open.
 * - No `createObjectURL` happens in this file, so there is nothing here to
 *   revoke: posters are owned by `CellPoster`'s module-scope LRU (which revokes
 *   on eviction) and the draft pane is a `srcDoc` string. The previous
 *   `activeBlobUrls` set never had anything inserted into it and is gone rather
 *   than standing as decoration for a cleanup that wasn't happening.
 */

import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Canvas, type ItemId, type Placement, type Viewport, type ItemRenderState } from '@ikenga/contract/canvas';

import {
  useStoryboardStore,
  selectHydratedCells,
  selectHydratedProject,
  selectRenderStatus,
} from '../storyboard-store';
import { useProjectStore, selectOpenProject } from '../project-store';
import { useAnchorsStore, selectAnchors } from '../anchors-store';
import { useSharedStore, selectCellUid } from '../shared-state';
import { CellPoster, prefetchPosters } from './composition/CellPoster';
import { getMcpClient, canvasApi, storyboardApi } from '../mcp-client';
import { subscribeStudioEvent } from '../bridge';
import { parseFountain, type FountainDoc } from '../lib/fountain';
import { deriveBeatShotLinks } from '../lib/tag-linking';
import { buildDraftDoc } from '../lib/draft-doc';
import { useAsyncAction } from '../lib/use-async-action';
import {
  emptyCanvasDoc,
  normalizeCanvasDoc,
  sweepOrphans,
  type CanvasDoc,
  type CanvasGroup,
} from '../lib/canvas-doc';
import {
  GRID_SNAP,
  LANE_STRIP_H,
  LANE_X0,
  LANE_STEP,
  PIPELINE_STAGES,
  buildNewLaneCell,
  deriveShotStage,
  inLaneBand,
  laneOrderFrom,
  laneSlot,
  nextLaneIndex,
  orderChanged,
  rollupStages,
  stageNodeId,
  stripDerived,
  type StageId,
} from '../lib/canvas-model';
import type { Cell, Anchor, ScriptBeat } from '../mcp-types';

export type NodeKind = 'stage' | 'script' | 'beat' | 'shot' | 'anchor' | 'group';

export interface CanvasNodeItem {
  id: string;
  kind: NodeKind;
  title: string;
  subtitle?: string;
  data?: unknown;
  index?: number;
}

export interface CanvasEdge {
  id: string;
  from: string;
  to?: string;
  /** Absolute canvas coordinate for an edge whose far end is not a node — the
   *  D-25-5 tether, which points at a lane SLOT, not at some phantom node id. */
  toPoint?: { x: number; y: number };
  type: 'stage' | 'script-beat' | 'beat-shot' | 'shot-anchor' | 'stage-shot' | 'tether';
  color?: string;
}

const DEFAULT_VIEWPORT: Viewport = { x: 40, y: 40, scale: 1.0 };
const MAX_LIVE_SRCDOC_PANES = 2;
/** Below this scale we skip media entirely (D-25-3 cap 4) — and, with it, the
 *  poster batch, so a zoomed-out board costs nothing. */
const LOD_MEDIA_MIN_SCALE = 0.45;
const SAVE_DEBOUNCE_MS = 400;

const SCRIPT_NODE_ID = 'node-script';
const NON_CELL_PREFIXES = ['stage-', 'beat-', 'anchor-', 'group-'];

/** Layout keys that address a shot (i.e. a cell uid) rather than a derived or
 *  authored non-cell node. Used only for tombstoning — never for deletion. */
function isCellKey(key: string): boolean {
  if (key === SCRIPT_NODE_ID) return false;
  return !NON_CELL_PREFIXES.some((p) => key.startsWith(p));
}

/** The watcher reports `<root>/.studio/canvas.json` as a `path:` pseudo-uid.
 *  Separators are OS-native, hence the normalize. */
function isCanvasDocUid(uid: string): boolean {
  if (!uid.startsWith('path:')) return false;
  return uid.replace(/\\/g, '/').endsWith('.studio/canvas.json');
}

/** Compare docs by content, ignoring the sidecar-stamped `updated_at` — which
 *  changes on every save and would otherwise make every write look like a
 *  remote edit coming back through the watcher. */
function serializeDoc(doc: CanvasDoc): string {
  const { updated_at: _ignored, ...rest } = doc;
  void _ignored;
  return JSON.stringify(rest);
}

const localKey = (projectId: string) => `ikenga:studio:canvas-doc:${projectId}`;

/**
 * Focus-trapped confirm, mirroring the Rail's `Modal` (views/Canvas.tsx) —
 * aria-modal, initial focus, a Tab cycle, a backdrop that dismisses, and an
 * Escape handler.
 *
 * The Escape handler is not optional decoration here. The canvas primitive
 * registers a WINDOW-level keydown where Escape means "exit edit mode + clear
 * selection" (`@ikenga/contract/canvas`'s use-pan-zoom). Left to bubble, the
 * universal dismiss gesture would silently drop the user's canvas selection and
 * leave an ARMED delete dialog open. `stopPropagation` in this bubble-phase
 * listener keeps the key from ever reaching that window listener.
 *
 * Portalled to <body> for the same reason the Rail portals: it escapes the
 * canvas transform (an absolutely-positioned child of the pan/zoom surface is
 * not reliably on top, or even on screen) and the app's pane-level focus trap.
 *
 * Kept local rather than imported: the Rail's `Modal` is module-private to
 * views/Canvas.tsx, and hoisting it into a shared module is a Rail edit outside
 * this seam. The two should be merged when something next touches both.
 */
function ConfirmDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const focusablesIn = (el: HTMLElement) =>
    Array.from(
      el.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ),
    ).filter((f) => f.offsetParent !== null);

  // Initial focus, ONCE. Deliberately not folded into the keydown effect below:
  // that one depends on `onClose`, and re-running it on every parent render
  // (mutationBusy flipping, a viewport nudge) would yank focus back to the first
  // control while the user is tabbing.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const opener = document.activeElement as HTMLElement | null;
    (focusablesIn(el)[0] ?? el).focus();
    // Hand focus back on Cancel/Escape. After a successful delete the opener is
    // gone from the DOM and `focus()` on a detached node is a no-op, which is
    // the right answer there too.
    return () => opener?.focus?.();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const focusables = () => focusablesIn(el);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Never let the canvas primitive's window-level Escape see this.
        e.preventDefault();
        e.stopPropagation();
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

export function NodeCanvas() {
  const project = useProjectStore(selectOpenProject);
  const projectDoc = useStoryboardStore(selectHydratedProject);
  const cells = useStoryboardStore(selectHydratedCells);
  const renderStatusMap = useStoryboardStore(selectRenderStatus);
  const anchors = useAnchorsStore(selectAnchors);
  const selectedCellUid = useSharedStore(selectCellUid);
  const setCellUid = useSharedStore((s) => s.setCellUid);

  // ─── authored state (.studio/canvas.json) ──────────────────────────────
  const [doc, setDoc] = useState<CanvasDoc>(emptyCanvasDoc);
  /** The project id `doc` was hydrated for. Saving before hydration completes
   *  would write an empty document over a real arrangement. */
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  const [persistMode, setPersistMode] = useState<'rpc' | 'local' | 'none'>('none');
  const [persistError, setPersistError] = useState<string | null>(null);
  const lastSavedRef = useRef<string>('');

  // ─── canvas-local (never shared, never persisted) ──────────────────────
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [showEdges, setShowEdges] = useState<boolean>(true);
  const [liveSrcdocUids, setLiveSrcdocUids] = useState<string[]>([]);
  const [cellHtml, setCellHtml] = useState<Record<string, { html: string; exists: boolean } | 'loading' | 'error'>>({});
  const [fountain, setFountain] = useState<FountainDoc | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);

  // G-61 behaviour 5 — the create / delete seams, through the SAME
  // `useAsyncAction` + `storyboardApi` pair the Rail uses, so one busy/error
  // shape covers both mutations and `storyboard.json` changes identically
  // whichever surface made the edit.
  const cellMutation = useAsyncAction();
  const [confirmDelete, setConfirmDelete] = useState<{ uid: string; beat: string } | null>(null);
  /** True once a create/delete on this surface resolved against the MOCK client.
   *  The mutation genuinely succeeded — against the in-memory demo board, not
   *  disk. See the create/delete block below for why this is a status line and
   *  not a gate. */
  const [demoWrite, setDemoWrite] = useState(false);

  const viewport = doc.viewport ?? DEFAULT_VIEWPORT;

  // Read cells without making the reconciliation effects depend on them.
  const cellsRef = useRef<Cell[]>(cells);
  cellsRef.current = cells;

  // ─── hydrate on project open (and ONLY there) ──────────────────────────
  useEffect(() => {
    const pid = project?.project_id;
    if (!pid) {
      setDoc(emptyCanvasDoc());
      setHydratedFor(null);
      setPersistMode('none');
      lastSavedRef.current = '';
      return;
    }
    let cancelled = false;
    void (async () => {
      let loaded = emptyCanvasDoc();
      let mode: 'rpc' | 'local' | 'none' = 'none';
      let err: string | null = null;
      try {
        const client = await getMcpClient();
        if (client.mode === 'real') {
          mode = 'rpc';
          const res = await canvasApi.read(client);
          loaded = res.exists ? normalizeCanvasDoc(res.doc) : emptyCanvasDoc();
        } else {
          // Standalone / demo: there is no project on disk to hold the file, so
          // the browser is the only place left. Explicitly the fallback, not
          // the design.
          mode = 'local';
          const raw = localStorage.getItem(localKey(pid));
          loaded = raw ? normalizeCanvasDoc(JSON.parse(raw) as unknown) : emptyCanvasDoc();
        }
      } catch (e) {
        // A FAILED read must not become an empty document: the next drag would
        // persist the blank over the real arrangement. Stay unhydrated (saving
        // is gated on `hydratedFor`) and say so.
        err = (e as Error).message;
        mode = 'none';
      }
      if (cancelled) return;
      if (mode === 'none') {
        setPersistError(err);
        setPersistMode('none');
        return;
      }
      // D-25-2 — the ONE lazy sweep point. Skipped when no cells have loaded
      // yet: reconciling an arrangement against an empty board would tombstone
      // every placement on it.
      const live = cellsRef.current;
      if (live.length > 0) {
        loaded = sweepOrphans(loaded, new Set(live.map((c) => c.uid)), isCellKey);
      }
      lastSavedRef.current = serializeDoc(loaded);
      setDoc(loaded);
      setPersistMode(mode);
      setPersistError(null);
      setHydratedFor(pid);
    })();
    return () => { cancelled = true; };
  }, [project?.project_id]);

  // ─── D-25-2: tombstone-only reconciliation on a cells refetch ──────────
  // Marks/clears tombstones. Never deletes a placement — that is the project-
  // open sweep's job, past the grace window.
  useEffect(() => {
    if (!project?.project_id || hydratedFor !== project.project_id) return;
    if (cells.length === 0) return;
    const live = new Set(cells.map((c) => c.uid));
    setDoc((prev) => {
      const orphans = { ...prev.orphans };
      let changed = false;
      for (const key of Object.keys(prev.layout)) {
        if (!isCellKey(key)) continue;
        if (live.has(key)) {
          if (orphans[key] !== undefined) { delete orphans[key]; changed = true; }
        } else if (orphans[key] === undefined) {
          orphans[key] = Date.now();
          changed = true;
        }
      }
      return changed ? { ...prev, orphans } : prev;
    });
  }, [cells, hydratedFor, project?.project_id]);

  // ─── debounced persist ─────────────────────────────────────────────────
  useEffect(() => {
    const pid = project?.project_id;
    if (!pid || hydratedFor !== pid || persistMode === 'none') return;
    const serialized = serializeDoc(doc);
    if (serialized === lastSavedRef.current) return;
    const t = setTimeout(() => {
      void (async () => {
        try {
          if (persistMode === 'rpc') {
            const client = await getMcpClient();
            if (client.mode !== 'real') return;
            await canvasApi.write(client, { ...doc, updated_at: '' });
          } else {
            localStorage.setItem(localKey(pid), serialized);
          }
          lastSavedRef.current = serialized;
          setPersistError(null);
        } catch (e) {
          setPersistError((e as Error).message);
        }
      })();
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [doc, project?.project_id, hydratedFor, persistMode]);

  // ─── live layout: arrange here, watch it move there ────────────────────
  useEffect(() => {
    const pid = project?.project_id;
    if (!pid || persistMode !== 'rpc' || hydratedFor !== pid) return;
    return subscribeStudioEvent('cells/changed', (payload) => {
      if (!(payload.changed_uids ?? []).some(isCanvasDocUid)) return;
      void (async () => {
        try {
          const client = await getMcpClient();
          if (client.mode !== 'real') return;
          const res = await canvasApi.read(client);
          if (!res.exists) return;
          const incoming = normalizeCanvasDoc(res.doc);
          const serialized = serializeDoc(incoming);
          // Our own write echoing back through the watcher — not a remote edit.
          if (serialized === lastSavedRef.current) return;
          lastSavedRef.current = serialized;
          setDoc(incoming);
        } catch {
          // Transient read failure — keep what we have rather than blanking it.
        }
      })();
    });
  }, [project?.project_id, persistMode, hydratedFor]);

  // ─── the script, for G-57 tag-derived beat→shot edges ──────────────────
  const loadFountain = useCallback(async () => {
    try {
      const client = await getMcpClient();
      const { exists, text } = await storyboardApi.read_fountain(client);
      setFountain(exists && text ? parseFountain(text) : null);
    } catch {
      // No script.fountain reachable → no tags → no beat→shot edges. An empty
      // answer, not a wrong one.
      setFountain(null);
    }
  }, []);

  useEffect(() => {
    if (!project?.project_id) { setFountain(null); return; }
    void loadFountain();
  }, [project?.project_id, loadFountain]);

  useEffect(() => {
    if (!project?.project_id) return;
    return subscribeStudioEvent('cells/changed', (payload) => {
      if (!(payload.changed_uids ?? []).some((u) => u.startsWith('project:script'))) return;
      void loadFountain();
    });
  }, [project?.project_id, loadFountain]);

  // ─── derived model ─────────────────────────────────────────────────────

  const groupById = useMemo(() => {
    const m = new Map<string, CanvasGroup>();
    for (const g of doc.groups) m.set(g.id, g);
    return m;
  }, [doc.groups]);

  /** A shot lives in at most ONE group (D-25-1). First declaration wins if a
   *  hand-edited canvas.json lists a uid twice. */
  const groupOfShot = useMemo(() => {
    const m = new Map<string, CanvasGroup>();
    for (const g of doc.groups) {
      for (const uid of g.shotUids) if (!m.has(uid)) m.set(uid, g);
    }
    return m;
  }, [doc.groups]);

  const collapsedSet = useMemo(() => new Set(doc.collapsed), [doc.collapsed]);

  /** Lane order: `Cell.index` ascending, stable in storyboard order on a board
   *  whose indexes have never been set (they are all 0 on a fresh scaffold). */
  const laneShots = useMemo(() => {
    return cells.map((c, i) => ({ cell: c, seq: i }))
      .sort((a, b) => a.cell.index - b.cell.index || a.seq - b.seq)
      .map((e) => e.cell);
  }, [cells]);

  const laneOrdinal = useMemo(() => {
    const m = new Map<string, number>();
    laneShots.forEach((c, i) => m.set(c.uid, i));
    return m;
  }, [laneShots]);

  const hiddenShotUids = useMemo(() => {
    const hidden = new Set<string>();
    for (const g of doc.groups) {
      if (!g.collapsed) continue;
      for (const uid of g.shotUids) hidden.add(uid);
    }
    return hidden;
  }, [doc.groups]);

  const shotStage = useMemo(() => {
    const m = new Map<string, StageId>();
    for (const c of cells) m.set(c.uid, deriveShotStage(c, renderStatusMap[c.uid]));
    return m;
  }, [cells, renderStatusMap]);

  const rollup = useMemo(
    () => rollupStages(cells, (uid) => renderStatusMap[uid]),
    [cells, renderStatusMap],
  );

  const items = useMemo<CanvasNodeItem[]>(() => {
    const list: CanvasNodeItem[] = [];

    PIPELINE_STAGES.forEach((st, idx) => {
      list.push({ id: stageNodeId(st.id), kind: 'stage', title: st.title, data: st.id, index: idx });
    });

    if (projectDoc?.script) {
      list.push({
        id: SCRIPT_NODE_ID,
        kind: 'script',
        title: projectDoc.title || 'Screenplay',
        subtitle: `${projectDoc.script.beats?.length || 0} beats`,
      });
    }

    (projectDoc?.script?.beats || []).forEach((b: ScriptBeat, idx: number) => {
      list.push({
        id: `beat-${b.id}`,
        kind: 'beat',
        title: b.scene_id ? `${b.scene_id}: ${b.id}` : b.id,
        subtitle: b.action || b.vo,
        data: b,
        index: idx,
      });
    });

    laneShots.forEach((cell: Cell, idx: number) => {
      if (hiddenShotUids.has(cell.uid)) return; // inside a collapsed group
      list.push({
        id: cell.uid,
        kind: 'shot',
        title: cell.label || `Shot ${idx + 1}`,
        subtitle: cell.prompt || '',
        data: cell,
        index: idx,
      });
    });

    doc.groups.forEach((g) => {
      list.push({
        id: `group-${g.id}`,
        kind: 'group',
        title: g.title || 'Group',
        subtitle: `${g.shotUids.length} shot${g.shotUids.length === 1 ? '' : 's'}`,
        data: g,
      });
    });

    anchors.forEach((anc: Anchor) => {
      list.push({ id: `anchor-${anc.id}`, kind: 'anchor', title: anc.name, subtitle: anc.kind, data: anc });
    });

    return list;
  }, [projectDoc, laneShots, hiddenShotUids, doc.groups, anchors]);

  /**
   * The DERIVED default placement for every node. Recomputed each render and
   * never persisted — `stripDerived` below drops anything that still equals its
   * entry here, which is what keeps the lane tracking `Cell.index` after the
   * user has dragged something else.
   */
  const derivedLayout = useMemo(() => {
    const derived: Record<string, Placement> = {};

    PIPELINE_STAGES.forEach((st, idx) => {
      derived[stageNodeId(st.id)] = { x: 40 + idx * 240, y: 40, w: 200, h: 64 };
    });

    derived[SCRIPT_NODE_ID] = { x: 40, y: 160, w: 220, h: 96 };

    (projectDoc?.script?.beats || []).forEach((b: ScriptBeat, idx: number) => {
      derived[`beat-${b.id}`] = { x: 300 + idx * 220, y: 160, w: 190, h: 96 };
    });

    laneShots.forEach((c, idx) => {
      derived[c.uid] = laneSlot(idx, doc.lane_collapsed);
    });

    doc.groups.forEach((g, gi) => {
      const firstOrdinal = g.shotUids
        .map((uid) => laneOrdinal.get(uid))
        .filter((n): n is number => n !== undefined)
        .sort((a, b) => a - b)[0];
      const x = firstOrdinal !== undefined ? LANE_X0 + firstOrdinal * LANE_STEP : LANE_X0 + gi * 220;
      derived[`group-${g.id}`] = { x, y: 600, w: 200, h: 84 };
    });

    anchors.forEach((a, idx) => {
      derived[`anchor-${a.id}`] = { x: 40 + idx * 220, y: 760, w: 180, h: 140 };
    });

    return derived;
  }, [projectDoc, laneShots, doc.lane_collapsed, doc.groups, laneOrdinal, anchors]);

  /** What the primitive actually gets: derived defaults with the authored
   *  placements laid on top, then collapse applied to the height. */
  const effectiveLayout = useMemo(() => {
    const computed: Record<ItemId, Placement> = {};
    for (const [id, p] of Object.entries(derivedLayout)) computed[id as ItemId] = p;
    for (const [id, p] of Object.entries(doc.layout)) computed[id as ItemId] = p;
    for (const id of doc.collapsed) {
      const p = computed[id as ItemId];
      if (p && p.h > LANE_STRIP_H) computed[id as ItemId] = { ...p, h: LANE_STRIP_H };
    }
    return computed;
  }, [derivedLayout, doc.layout, doc.collapsed]);

  // Refs, so the drag handler reads the CURRENT model without re-identifying
  // itself (and re-registering with the primitive) on every render.
  const derivedLayoutRef = useRef(derivedLayout);
  derivedLayoutRef.current = derivedLayout;
  const laneShotsRef = useRef(laneShots);
  laneShotsRef.current = laneShots;
  const docRef = useRef(doc);
  docRef.current = doc;

  // ─── edges ─────────────────────────────────────────────────────────────

  const beatShotLinks = useMemo(() => {
    // G-57 — tags keyed by uid, via the same module Breakdown links on. The
    // `beat_id` FK is deliberately not consulted anywhere in this file.
    return deriveBeatShotLinks(
      fountain,
      cells.map((c) => ({ uid: c.uid, shotId: c.label || c.uid })),
      (projectDoc?.script?.beats ?? []).map((b) => ({
        id: b.id,
        ...(b.scene_id ? { scene_id: b.scene_id } : {}),
        ...(b.shot_id ? { shot_id: b.shot_id } : {}),
      })),
    );
  }, [fountain, cells, projectDoc]);

  const edges = useMemo<CanvasEdge[]>(() => {
    if (!showEdges) return [];
    const list: CanvasEdge[] = [];
    const visible = new Set(items.map((i) => i.id));

    for (let i = 0; i < PIPELINE_STAGES.length - 1; i++) {
      list.push({
        id: `e-stage-${PIPELINE_STAGES[i].id}-${PIPELINE_STAGES[i + 1].id}`,
        from: stageNodeId(PIPELINE_STAGES[i].id),
        to: stageNodeId(PIPELINE_STAGES[i + 1].id),
        type: 'stage',
        color: 'var(--info)',
      });
    }

    (projectDoc?.script?.beats || []).forEach((b) => {
      list.push({
        id: `e-script-beat-${b.id}`,
        from: SCRIPT_NODE_ID,
        to: `beat-${b.id}`,
        type: 'script-beat',
        color: 'var(--agent)',
      });
    });

    for (const link of beatShotLinks) {
      if (!visible.has(link.cellUid)) continue;
      list.push({
        id: `e-beat-shot-${link.beatId}-${link.cellUid}`,
        from: `beat-${link.beatId}`,
        to: link.cellUid,
        type: 'beat-shot',
        color: 'var(--border-soft)',
      });
    }

    cells.forEach((c) => {
      if (!visible.has(c.uid)) return;
      (c.anchors || []).forEach((aid) => {
        list.push({
          id: `e-shot-anc-${c.uid}-${aid}`,
          from: c.uid,
          to: `anchor-${aid}`,
          type: 'shot-anchor',
          color: 'color-mix(in oklab, var(--agent) 40%, transparent)',
        });
      });
    });

    // D-25-1 stage MEMBERSHIP. Every shot carries its stage as a chip
    // unconditionally; the edges are drawn on demand — for the selected stage's
    // members, or for the selected shot's own stage — because 40-100
    // simultaneous membership lines make the board unreadable, which is the one
    // thing the canvas exists to fix.
    const selStage = selectedNodeId?.startsWith('stage-')
      ? (selectedNodeId.slice('stage-'.length) as StageId)
      : null;
    cells.forEach((c) => {
      if (!visible.has(c.uid)) return;
      const stage = shotStage.get(c.uid);
      if (!stage) return;
      const isSelectedStage = selStage === stage;
      const isSelectedShot = selectedNodeId === c.uid;
      if (!isSelectedStage && !isSelectedShot) return;
      list.push({
        id: `e-stage-shot-${stage}-${c.uid}`,
        from: stageNodeId(stage),
        to: c.uid,
        type: 'stage-shot',
        color: 'color-mix(in oklab, var(--info) 55%, transparent)',
      });
    });

    // D-25-5 tether — a broken-out shot points back at its lane SLOT, which is
    // a coordinate, not a node. (The previous version aimed at a `lane-slot-N`
    // id that was never in the layout, so the renderer bailed and no tether
    // could ever draw.)
    laneShots.forEach((c, idx) => {
      if (!visible.has(c.uid)) return;
      const p = effectiveLayout[c.uid as ItemId];
      if (!p || inLaneBand(p)) return;
      const slot = laneSlot(idx, doc.lane_collapsed);
      list.push({
        id: `e-tether-${c.uid}`,
        from: c.uid,
        toPoint: { x: slot.x + slot.w / 2, y: slot.y },
        type: 'tether',
        color: 'var(--achievement)',
      });
    });

    return list;
  }, [showEdges, items, projectDoc, beatShotLinks, cells, shotStage, selectedNodeId, laneShots, effectiveLayout, doc.lane_collapsed]);

  // ─── posters: ONE render.list_posters for the board (not N+1) ──────────
  const visibleDoneRecordIds = useMemo(() => {
    if (viewport.scale < LOD_MEDIA_MIN_SCALE) return [] as string[];
    const ids: string[] = [];
    for (const item of items) {
      if (item.kind !== 'shot') continue;
      const cell = item.data as Cell | undefined;
      const done = cell?.renders?.slice().reverse().find((r) => r.status === 'done');
      if (done?.id) ids.push(done.id);
    }
    return ids;
  }, [items, viewport.scale]);

  useEffect(() => {
    if (visibleDoneRecordIds.length > 0) prefetchPosters(visibleDoneRecordIds);
  }, [visibleDoneRecordIds]);

  // ─── live srcdoc panes (WP-30, D-25-3) ─────────────────────────────────

  /** Which uids we have already asked the sidecar for. A ref, not state: the
   *  fetch effect must not re-run (and tear down its own in-flight request)
   *  merely because it wrote `loading` into the map it depends on. */
  const contentRequested = useRef<Set<string>>(new Set());

  const toggleLiveSrcdoc = useCallback((uid: string) => {
    setLiveSrcdocUids((prev) => {
      if (prev.includes(uid)) return prev.filter((id) => id !== uid);
      // D-25-3 cap 1 — at most two live panes on the canvas at once.
      return [uid, ...prev].slice(0, MAX_LIVE_SRCDOC_PANES);
    });
  }, []);

  // Release the source of any pane that is no longer open (closed, or evicted
  // by the cap), so re-opening it reads the file again instead of replaying
  // whatever it said the first time. Declared BEFORE the fetch effect so a
  // single toggle reconciles then loads, in that order.
  useEffect(() => {
    const open = new Set(liveSrcdocUids);
    for (const uid of Array.from(contentRequested.current)) {
      if (!open.has(uid)) contentRequested.current.delete(uid);
    }
    setCellHtml((prev) => {
      const next: typeof prev = {};
      let dropped = false;
      for (const [uid, value] of Object.entries(prev)) {
        if (open.has(uid)) next[uid] = value;
        else dropped = true;
      }
      return dropped ? next : prev;
    });
  }, [liveSrcdocUids]);

  // Load the cell's REAL authored source for each open pane, through the same
  // `storyboard.read_cell_content` seam the Cell view's editor uses. The
  // previous version interpolated `cell.prompt` into a hardcoded placeholder
  // document instead — which previewed nothing real AND made agent-authored
  // project text into live markup.
  useEffect(() => {
    const pending = liveSrcdocUids.filter((uid) => !contentRequested.current.has(uid));
    if (pending.length === 0) return;
    for (const uid of pending) contentRequested.current.add(uid);
    setCellHtml((prev) => {
      const next = { ...prev };
      for (const uid of pending) next[uid] = 'loading';
      return next;
    });
    void (async () => {
      const client = await getMcpClient();
      for (const uid of pending) {
        try {
          const res = await storyboardApi.read_cell_content(client, uid);
          setCellHtml((prev) => ({ ...prev, [uid]: { html: res.html, exists: res.exists } }));
        } catch {
          contentRequested.current.delete(uid); // let a retry happen
          setCellHtml((prev) => ({ ...prev, [uid]: 'error' }));
        }
      }
    })();
  }, [liveSrcdocUids]);

  // A new project is a new set of cells — drop every cached source.
  useEffect(() => {
    contentRequested.current.clear();
    setCellHtml({});
    setLiveSrcdocUids([]);
    // …and any cell-mutation state, which described the OLD board: a confirm
    // armed on a uid that is no longer on screen, and the demo-board notice.
    setConfirmDelete(null);
    setDemoWrite(false);
  }, [project?.project_id]);

  // ─── mutations ─────────────────────────────────────────────────────────

  const handleViewportChange = useCallback((vp: Viewport) => {
    setDoc((prev) => (
      prev.viewport && prev.viewport.x === vp.x && prev.viewport.y === vp.y && prev.viewport.scale === vp.scale
        ? prev
        : { ...prev, viewport: vp }
    ));
  }, []);

  const setViewport = useCallback((fn: (v: Viewport) => Viewport) => {
    setDoc((prev) => ({ ...prev, viewport: fn(prev.viewport ?? DEFAULT_VIEWPORT) }));
  }, []);

  /**
   * D-25-5's one sanctioned gesture. A drop inside the lane band rewrites the
   * board's ordinals through `storyboard.reorder_cells`; anything else is free
   * placement and writes nothing but layout.
   */
  const commitLaneReorder = useCallback(async (nextLayout: Record<ItemId, Placement>) => {
    const shots = laneShotsRef.current;
    if (shots.length < 2) return;
    const before = shots.map((c) => c.uid);
    const after = laneOrderFrom(
      shots.map((c) => ({ uid: c.uid, index: c.index })),
      (uid) => nextLayout[uid as ItemId],
    );
    if (!orderChanged(before, after)) return;
    setReorderBusy(true);
    try {
      const client = await getMcpClient();
      if (client.mode !== 'real') return; // demo board: nothing on disk to reorder
      await storyboardApi.reorder_cells(client, after);
      await useStoryboardStore.getState().refetch();
    } catch (e) {
      setPersistError(`reorder failed: ${(e as Error).message}`);
    } finally {
      setReorderBusy(false);
    }
  }, []);

  // D-25-5 sanctions the DROP as the index-writing gesture — but the contract
  // primitive's onLayoutChange fires on every snapped mousemove mid-drag, so
  // committing there rewrites Cell.index once per slot crossing (and a drag
  // that ends OUTSIDE the lane can persist a reorder the user never dropped
  // on). Buffer the latest layout and flush once, at gesture end: pointerup
  // when a pointer gesture is live, with a debounce fallback for layout
  // changes that arrive outside one.
  const pendingReorderRef = useRef<Record<ItemId, Placement> | null>(null);
  const reorderFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushLaneReorder = useCallback(() => {
    if (reorderFlushTimerRef.current) {
      clearTimeout(reorderFlushTimerRef.current);
      reorderFlushTimerRef.current = null;
    }
    window.removeEventListener('pointerup', flushLaneReorder);
    const pending = pendingReorderRef.current;
    pendingReorderRef.current = null;
    if (pending) void commitLaneReorder(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitLaneReorder]);

  useEffect(() => () => {
    window.removeEventListener('pointerup', flushLaneReorder);
    if (reorderFlushTimerRef.current) clearTimeout(reorderFlushTimerRef.current);
  }, [flushLaneReorder]);

  const handleLayoutChange = useCallback((nextLayout: Record<ItemId, Placement>) => {
    const derived = derivedLayoutRef.current;
    const prevDoc = docRef.current;
    const laneUids = new Set(laneShotsRef.current.map((c) => c.uid));
    const collapsed = new Set(prevDoc.collapsed);

    // Collapse is a VIEW state applied to the height on the way out
    // (`effectiveLayout`), so the strip height it produces must not come back
    // in as an authored one — otherwise expanding a node the user had also
    // dragged would leave it stuck at 44px forever.
    const normalized: Record<string, Placement> = {};
    for (const [id, p] of Object.entries(nextLayout as Record<string, Placement>)) {
      normalized[id] = collapsed.has(id)
        ? { ...p, h: prevDoc.layout[id]?.h ?? derived[id]?.h ?? p.h }
        : p;
    }

    // Persist ONLY what the user authored: anything still equal to its derived
    // default is dropped, and a shot resting inside the lane band is dropped
    // outright — the lane owns its position, so persisting one would freeze it
    // against the next agent reorder (D-25-5: "lane position = its index …
    // derived, not authored").
    const authored = stripDerived(normalized, derived);
    for (const uid of laneUids) {
      if (inLaneBand(nextLayout[uid as ItemId])) delete authored[uid];
    }

    setDoc((prev) => ({ ...prev, layout: authored }));
    if (!pendingReorderRef.current) {
      window.addEventListener('pointerup', flushLaneReorder, { once: true });
    }
    pendingReorderRef.current = nextLayout;
    if (reorderFlushTimerRef.current) clearTimeout(reorderFlushTimerRef.current);
    reorderFlushTimerRef.current = setTimeout(flushLaneReorder, 400);
  }, [flushLaneReorder]);

  const handleSelectionChange = useCallback((id: ItemId | null) => {
    const nodeId = (id as string) ?? null;
    setSelectedNodeId(nodeId);
    // cellUid is SHARED state that Cell/Composition read as a real cell uid.
    // Only a shot node may write it — selecting a beat/stage/anchor/group used
    // to poison it with `beat-…` / `stage-…`, so switching to the Cell view
    // afterwards targeted a cell that does not exist.
    if (nodeId && laneOrdinal.has(nodeId)) setCellUid(nodeId);
  }, [laneOrdinal, setCellUid]);

  // Cross-view selection the other way: a shot picked in the Rail / Cell view
  // highlights here too.
  useEffect(() => {
    if (selectedCellUid && laneOrdinal.has(selectedCellUid)) setSelectedNodeId(selectedCellUid);
  }, [selectedCellUid, laneOrdinal]);

  const toggleCollapsed = useCallback((nodeId: string) => {
    setDoc((prev) => {
      const has = prev.collapsed.includes(nodeId);
      return {
        ...prev,
        collapsed: has ? prev.collapsed.filter((c) => c !== nodeId) : [...prev.collapsed, nodeId],
      };
    });
  }, []);

  const activeGroup = useMemo(() => {
    if (!selectedNodeId?.startsWith('group-')) return null;
    return groupById.get(selectedNodeId.slice('group-'.length)) ?? null;
  }, [selectedNodeId, groupById]);

  const createGroup = useCallback(() => {
    setDoc((prev) => {
      const id = `g${Date.now().toString(36)}`;
      const seed = selectedNodeId && laneOrdinal.has(selectedNodeId) ? [selectedNodeId] : [];
      const group: CanvasGroup = {
        id,
        title: `Group ${prev.groups.length + 1}`,
        shotUids: seed,
        collapsed: false,
      };
      return { ...prev, groups: [...prev.groups, group] };
    });
  }, [selectedNodeId, laneOrdinal]);

  const toggleMembership = useCallback((groupId: string, uid: string) => {
    setDoc((prev) => ({
      ...prev,
      groups: prev.groups.map((g) => {
        if (g.id !== groupId) {
          // A shot lives in exactly one group (D-25-1) — joining one leaves the
          // other.
          return g.shotUids.includes(uid) ? { ...g, shotUids: g.shotUids.filter((u) => u !== uid) } : g;
        }
        return g.shotUids.includes(uid)
          ? { ...g, shotUids: g.shotUids.filter((u) => u !== uid) }
          : { ...g, shotUids: [...g.shotUids, uid] };
      }),
    }));
  }, []);

  const toggleGroupCollapsed = useCallback((groupId: string) => {
    setDoc((prev) => ({
      ...prev,
      groups: prev.groups.map((g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g)),
    }));
  }, []);

  const removeGroup = useCallback((groupId: string) => {
    // The GROUP goes; the shots and their placements stay. (D-25-2's converse:
    // a cell disappearing never takes its group with it either.)
    setDoc((prev) => ({
      ...prev,
      groups: prev.groups.filter((g) => g.id !== groupId),
      layout: Object.fromEntries(Object.entries(prev.layout).filter(([k]) => k !== `group-${groupId}`)),
    }));
    setSelectedNodeId(null);
  }, []);

  const toggleLaneCollapsed = useCallback(() => {
    setDoc((prev) => ({ ...prev, lane_collapsed: !prev.lane_collapsed }));
  }, []);

  // ─── create / delete a shot (G-61 behaviour 5) ─────────────────────────
  //
  // Same two RPCs the Rail calls, same refetch afterwards. Nothing about the
  // canvas is involved: a new cell takes its lane slot from `Cell.index` like
  // every other shot (no authored placement is written), and a deleted one
  // leaves its placement behind as a D-25-2 tombstone rather than being swept
  // here — the cells refetch and the `cells/changed` event do the rest, on both
  // surfaces at once.
  //
  // MOCK MODE — deliberately NOT gated on `client.mode === 'real'`, unlike
  // `commitLaneReorder` above. The asymmetry is real and worth stating, because
  // it reads like an oversight:
  //   • `storyboard.reorder_cells` has NO case in `__mocks__/mcp.ts`, so calling
  //     it on the demo board throws a raw 'unknown tool' — the guard there is
  //     what keeps a demo drag from raising a meaningless banner.
  //   • `storyboard.create_cell` / `storyboard.delete_cell` DO have cases
  //     (they mutate the module-level MOCK_CELLS and emit `cells/changed`), and
  //     the Rail calls them ungated. Demo-board create/delete is a working,
  //     intended demo affordance; gating it HERE would make the same gesture
  //     work in the Rail and fail on the canvas, on the same board.
  // What is genuinely wrong in mock mode is silence: `getMcpClient` degrades to
  // the mock when the studio MCP server is slow or crash-looping (it re-probes
  // every PROBE_RETRY_MS), so a create can appear to succeed, write nothing to
  // disk, and be erased seconds later when the real client comes back. So the
  // mode is recorded and reported on the status line instead of being swallowed.
  const {
    run: runCellMutation,
    busy: mutationBusy,
    error: mutationError,
    clearError: clearMutationError,
  } = cellMutation;

  const createCellAtLaneEnd = useCallback(async () => {
    if (mutationBusy) return;
    const cell = buildNewLaneCell({ index: nextLaneIndex(cellsRef.current) });
    await runCellMutation(
      async (client) => {
        await storyboardApi.create_cell(client, cell);
        setDemoWrite(client.mode !== 'real');
        await useStoryboardStore.getState().refetch();
        // Select it here AND in shared state, so the Cell view opens on the
        // same shot if the user switches — the Rail's `setCellUid` half. The
        // Rail also flips the focused pane to the Cell view; this surface
        // deliberately does not, because the request was for a cell ON the
        // canvas and yanking the pane away would lose the arrangement in view.
        setCellUid(cell.uid);
        setSelectedNodeId(cell.uid);
      },
      { onError: (err) => `Couldn't create the cell — ${(err as Error).message}` },
    );
  }, [mutationBusy, runCellMutation, setCellUid]);

  const deleteCell = useCallback(async (uid: string) => {
    if (mutationBusy) return;
    await runCellMutation(
      async (client) => {
        await storyboardApi.delete_cell(client, uid);
        setDemoWrite(client.mode !== 'real');
        if (selectedCellUid === uid) setCellUid(null);
        setSelectedNodeId((prev) => (prev === uid ? null : prev));
        await useStoryboardStore.getState().refetch();
        setConfirmDelete(null);
      },
      { onError: (err) => `Couldn't delete the cell — ${(err as Error).message}` },
    );
  }, [mutationBusy, runCellMutation, selectedCellUid, setCellUid]);

  const requestDeleteCell = useCallback((uid: string, beat: string) => {
    clearMutationError();
    setConfirmDelete({ uid, beat });
  }, [clearMutationError]);

  /** Stable so the confirm's focus trap isn't torn down and rebuilt on every
   *  parent render. */
  const closeConfirm = useCallback(() => setConfirmDelete(null), []);

  /** The name a destructive control is announced by. Must be the Rail's
   *  `DisplayCell.beat` (`beat_id || label || uid`, storyboard-store.ts) and NOT
   *  `label`: this surface's only create path hardcodes NEW_CELL_LABEL with no
   *  label input, so three '+ New cell' clicks give three shots all labelled
   *  'new beat'. Keying the accessible name on `label` would render three
   *  identical "Delete cell new beat" buttons — an ambiguous target for a UI
   *  driver (a destructive write to the wrong shot) and three indistinguishable
   *  destructive controls for a screen reader. `beat_id` carries a random
   *  suffix, so it is unique per cell. */
  const beatNameOf = useCallback(
    (cell: Cell) => cell.beat_id || cell.label || cell.uid,
    [],
  );

  // ─── rendering ─────────────────────────────────────────────────────────

  const renderItem = useCallback((item: CanvasNodeItem, state: ItemRenderState) => {
    const isSelected = state.isSelected || item.id === selectedNodeId;
    const scale = viewport.scale;

    // LOD floor — a chip and nothing else. Free (D-25-3 cap 4).
    if (scale < LOD_MEDIA_MIN_SCALE) {
      return (
        <div
          className={[
            'h-full w-full rounded border bg-surface p-2 flex items-center justify-between font-mono text-[10px]',
            isSelected ? 'border-[var(--achievement)] ring-2 ring-[var(--achievement)]' : 'border-soft',
          ].join(' ')}
        >
          <span className="truncate font-semibold text-fg">{item.title}</span>
          <span className="text-[8px] uppercase tracking-wider text-fg-faint">{item.kind}</span>
        </div>
      );
    }

    if (item.kind === 'stage') {
      const stageId = item.data as StageId;
      const count = rollup.counts[stageId] ?? 0;
      const failed = rollup.failed[stageId] ?? 0;
      return (
        <div
          className={[
            'h-full w-full rounded-md border border-dashed p-3 flex flex-col justify-between',
            'bg-[color-mix(in_oklab,var(--info)_8%,var(--bg-surface))]',
            isSelected ? 'border-[var(--achievement)]' : 'border-[var(--info)]',
          ].join(' ')}
          title={
            failed > 0
              ? `${count} shot${count === 1 ? '' : 's'} at this stage · ${failed} failed`
              : `${count} shot${count === 1 ? '' : 's'} at this stage`
          }
        >
          <div className="flex items-center justify-between">
            <span className="font-mono text-[9px] uppercase tracking-wider text-[var(--info)]">Pipeline Stage</span>
            <span className="font-mono text-[9px] tabular-nums text-fg-faint">
              {String(Number(item.index) + 1).padStart(2, '0')}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-fg text-[13px]">{item.title}</span>
            <span className="flex items-center gap-1 font-mono text-[10px] tabular-nums text-fg-muted">
              {/* D-25-4 (proposed): counts are primary; a failure promotes a
                  warning WITHOUT changing the count. */}
              {count}/{cells.length}
              {failed > 0 && (
                <span className="text-[var(--danger)]" title={`${failed} failed`}>⚠ {failed}</span>
              )}
            </span>
          </div>
        </div>
      );
    }

    if (item.kind === 'script') {
      return (
        <div className="h-full w-full rounded-md border border-soft bg-surface p-3 flex flex-col justify-between shadow-sm">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[9px] uppercase tracking-wider text-[var(--agent)]">Screenplay</span>
            <span className="font-mono text-[9px] text-fg-faint">{item.subtitle}</span>
          </div>
          <span className="font-medium text-fg text-[12px] truncate">{item.title}</span>
          <div className="text-[10px] text-fg-muted truncate">
            {fountain ? 'script.fountain · tagged links live' : 'no script.fountain on disk'}
          </div>
        </div>
      );
    }

    if (item.kind === 'beat') {
      return (
        <div className="h-full w-full rounded-md border border-soft bg-surface p-2.5 flex flex-col justify-between shadow-sm">
          <div className="flex items-center justify-between font-mono text-[9px]">
            <span className="text-[var(--achievement)] font-semibold truncate">{item.title}</span>
            <span className="text-fg-faint">#beat</span>
          </div>
          <p className="text-[10px] text-fg-muted line-clamp-2">{item.subtitle || 'Beat action'}</p>
        </div>
      );
    }

    if (item.kind === 'group') {
      const g = item.data as CanvasGroup;
      return (
        <div
          className={[
            'h-full w-full rounded-md border-2 border-dashed p-2.5 flex flex-col justify-between',
            'bg-[color-mix(in_oklab,var(--achievement)_7%,var(--bg-surface))]',
            isSelected ? 'border-[var(--achievement)]' : 'border-[color-mix(in_oklab,var(--achievement)_45%,transparent)]',
          ].join(' ')}
        >
          <div className="flex items-center justify-between font-mono text-[9px]">
            <span className="uppercase tracking-wider text-[var(--achievement)]">Group</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); toggleGroupCollapsed(g.id); }}
              className="rounded border border-soft px-1 py-px text-[8px] uppercase text-fg-muted hover:text-fg"
              title={g.collapsed ? 'Expand this group back onto the canvas' : 'Collapse this group — its shots fold into this tile'}
            >
              {g.collapsed ? '▸ Collapsed' : '▾ Expanded'}
            </button>
          </div>
          <div className="truncate text-[12px] font-medium text-fg">{item.title}</div>
          <div className="font-mono text-[9px] text-fg-faint">{item.subtitle}</div>
        </div>
      );
    }

    if (item.kind === 'anchor') {
      const anc = item.data as Anchor | undefined;
      return (
        <div className="h-full w-full rounded-md border border-[var(--border)] bg-surface p-2.5 flex flex-col justify-between shadow-sm">
          <div className="flex items-center justify-between font-mono text-[9px]">
            <span className="text-[var(--agent)] uppercase">{anc?.kind ?? '3D Anchor'}</span>
            <span className="text-fg-faint">#ref</span>
          </div>
          <div className="font-medium text-fg text-[11px] truncate">{item.title}</div>
          <div className="rounded bg-sunken p-1 text-[9px] font-mono text-fg-faint truncate">
            {(anc?.metadata?.notes as string) || anc?.asset?.uri || 'Deterministic 3D plate'}
          </div>
        </div>
      );
    }

    if (item.kind === 'shot') {
      const cell = item.data as Cell | undefined;
      if (!cell) return null;
      const status = renderStatusMap[cell.uid];
      const doneRecord = cell.renders?.slice().reverse().find((r) => r.status === 'done');
      const isLiveSrcdoc = liveSrcdocUids.includes(item.id);
      const isHtmlCell = cell.content_path?.endsWith('.html');
      const isCollapsed = collapsedSet.has(item.id);
      const stage = shotStage.get(cell.uid);
      const group = groupOfShot.get(cell.uid);
      const content = cellHtml[cell.uid];

      if (isCollapsed) {
        return (
          <div
            className={[
              'h-full w-full rounded-md border bg-surface px-2 flex items-center justify-between gap-2 font-mono text-[10px]',
              isSelected ? 'border-[var(--achievement)] ring-2 ring-[var(--achievement)]' : 'border-soft',
            ].join(' ')}
          >
            <span className="truncate text-fg">
              {String(Number(item.index) + 1).padStart(2, '0')} · {cell.label || cell.uid}
            </span>
            <span className="flex items-center gap-1">
              {stage && <span className="rounded bg-raised px-1 py-px text-[8px] uppercase text-fg-muted">{stage}</span>}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); toggleCollapsed(item.id); }}
                className="rounded border border-soft px-1 text-[8px] text-fg-muted hover:text-fg"
                title="Expand this shot"
              >
                ▾
              </button>
              {/* Same delete seam as the expanded card — a collapsed strip must
                  not be a state where the shot can't be removed. */}
              <button
                type="button"
                aria-label={`Delete cell ${beatNameOf(cell)}`}
                onClick={(e) => { e.stopPropagation(); requestDeleteCell(cell.uid, beatNameOf(cell)); }}
                className="rounded border border-soft px-1 text-[8px] text-fg-faint hover:border-[var(--danger)] hover:text-[var(--danger)]"
                title="Delete cell"
              >
                <span aria-hidden>✕</span>
              </button>
            </span>
          </div>
        );
      }

      return (
        <div
          className={[
            'h-full w-full rounded-md border bg-surface p-2 flex flex-col justify-between transition-shadow shadow-sm hover:shadow-md cursor-pointer',
            isSelected ? 'border-[var(--achievement)] ring-2 ring-[var(--achievement)]' : 'border-soft',
          ].join(' ')}
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-1 border-b border-soft pb-1">
            <div className="flex items-center gap-1 font-mono text-[9px]">
              <span className="text-fg-faint">{String(Number(item.index) + 1).padStart(2, '0')}</span>
              <span className="font-semibold text-fg truncate max-w-[80px]">{cell.label || item.id}</span>
            </div>
            <div className="flex items-center gap-1">
              {isHtmlCell && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); toggleLiveSrcdoc(item.id); }}
                  className={[
                    'rounded px-1 py-px font-mono text-[7.5px] uppercase border',
                    isLiveSrcdoc ? 'border-[var(--info)] bg-[var(--info)] text-[var(--bg-base)]' : 'border-soft text-fg-muted',
                  ].join(' ')}
                  title="Draft preview of this cell's real source — weaker than the render (no scripts, no external assets)"
                >
                  Draft
                </button>
              )}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); toggleCollapsed(item.id); }}
                className="rounded border border-soft px-1 py-px font-mono text-[7.5px] text-fg-muted hover:text-fg"
                title="Collapse this shot to a strip"
              >
                ▴
              </button>
              {/* G-61 b5 — real `storyboard.delete_cell`, behind the same
                  confirm the Rail asks for. */}
              <button
                type="button"
                aria-label={`Delete cell ${beatNameOf(cell)}`}
                onClick={(e) => { e.stopPropagation(); requestDeleteCell(cell.uid, beatNameOf(cell)); }}
                className="rounded border border-soft px-1 py-px font-mono text-[7.5px] text-fg-faint hover:border-[var(--danger)] hover:text-[var(--danger)]"
                title="Delete cell"
              >
                <span aria-hidden>✕</span>
              </button>
            </div>
          </div>

          {/* Media — poster, or the cell's REAL source as a draft pane */}
          <div className="relative my-1 flex-1 overflow-hidden rounded bg-sunken flex items-center justify-center">
            {isLiveSrcdoc ? (
              <div className="relative h-full w-full">
                {content === 'loading' || content === undefined ? (
                  <span className="absolute inset-0 grid place-items-center font-mono text-[9px] text-fg-faint">
                    loading source…
                  </span>
                ) : content === 'error' ? (
                  <span className="absolute inset-0 grid place-items-center font-mono text-[9px] text-[var(--danger)]">
                    could not read source
                  </span>
                ) : content.exists ? (
                  <iframe
                    title={`Draft preview of ${item.title}`}
                    // The cell's REAL authored html, wrapped by the same builder
                    // the Cell view's draft pane uses. `sandbox=""` — no scripts
                    // and never `allow-same-origin`: this is project data an
                    // agent or a collaborator wrote, so it gets a null origin
                    // and a static first paint, exactly as the ladder describes.
                    // NOTHING is string-interpolated into markup here.
                    srcDoc={buildDraftDoc(content.html)}
                    sandbox=""
                    className="h-full w-full border-none pointer-events-none"
                  />
                ) : (
                  <span className="absolute inset-0 grid place-items-center px-2 text-center font-mono text-[9px] text-fg-faint">
                    no source written yet
                  </span>
                )}
                <span className="absolute bottom-1 right-1 rounded bg-surface/80 px-1 font-mono text-[7px] text-fg-faint">
                  draft · weaker than the render
                </span>
              </div>
            ) : doneRecord?.id ? (
              <CellPoster recordId={doneRecord.id} alt={item.title} className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <span className="font-mono text-[9px] text-fg-faint">
                {status === 'running' ? 'Rendering…' : status === 'queued' ? 'Queued' : 'Not rendered'}
              </span>
            )}
          </div>

          {/* Prompt excerpt — TEXT, in a text node. Never markup. */}
          <div className="truncate text-[10px] text-fg-muted font-sans" title={cell.prompt}>
            {cell.prompt || 'No prompt'}
          </div>

          {/* Badges: pipeline stage (D-25-1 membership) + group (containment) */}
          <div className="flex items-center gap-1 pt-1 font-mono text-[8px]">
            {stage && (
              <span
                className="rounded bg-[color-mix(in_oklab,var(--info)_16%,transparent)] px-1 py-px uppercase text-[var(--info)]"
                title="Pipeline stage this shot is currently in (membership — stages never own shots)"
              >
                {stage}
              </span>
            )}
            {group && (
              <span className="truncate rounded bg-[color-mix(in_oklab,var(--achievement)_16%,transparent)] px-1 py-px text-[var(--achievement)]">
                {group.title || 'group'}
              </span>
            )}
            {activeGroup && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); toggleMembership(activeGroup.id, cell.uid); }}
                className="ml-auto rounded border border-soft px-1 py-px text-fg-muted hover:text-fg"
                title={`${activeGroup.shotUids.includes(cell.uid) ? 'Remove from' : 'Add to'} ${activeGroup.title || 'group'}`}
              >
                {activeGroup.shotUids.includes(cell.uid) ? '− group' : '+ group'}
              </button>
            )}
          </div>

          {/* Bottom info bar */}
          <div className="flex items-center justify-between pt-1 border-t border-soft font-mono text-[8.5px] text-fg-faint">
            <span>{cell.duration_ms ? `${(cell.duration_ms / 1000).toFixed(1)}s` : '—'}</span>
            <span className={status === 'done' ? 'text-[var(--live)]' : status === 'running' ? 'text-[var(--info)]' : ''}>
              {status === 'done' ? '✓ Ready' : status === 'running' ? '◐ In flight' : '○ Standby'}
            </span>
          </div>
        </div>
      );
    }

    return (
      <div className="h-full w-full rounded border border-soft bg-surface p-2">
        <span className="text-[11px] font-medium text-fg">{item.title}</span>
      </div>
    );
  }, [
    selectedNodeId, renderStatusMap, viewport.scale, liveSrcdocUids, toggleLiveSrcdoc,
    collapsedSet, toggleCollapsed, shotStage, groupOfShot, cellHtml, rollup, cells.length,
    activeGroup, toggleMembership, toggleGroupCollapsed, fountain, requestDeleteCell, beatNameOf,
  ]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-base">
      {/* Edge layer — pans/zooms with the canvas. */}
      {showEdges && (
        <svg
          className="pointer-events-none absolute inset-0 z-0 h-full w-full"
          style={{
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
            transformOrigin: '0 0',
          }}
        >
          {edges.map((e) => {
            const pFrom = effectiveLayout[e.from as ItemId];
            if (!pFrom) return null;
            let x2: number;
            let y2: number;
            if (e.toPoint) {
              x2 = e.toPoint.x;
              y2 = e.toPoint.y;
            } else {
              const pTo = e.to ? effectiveLayout[e.to as ItemId] : undefined;
              if (!pTo) return null;
              x2 = pTo.x + pTo.w / 2;
              y2 = pTo.y;
            }
            const x1 = pFrom.x + pFrom.w / 2;
            const y1 = pFrom.y + pFrom.h;
            const isTether = e.type === 'tether';

            return (
              <line
                key={e.id}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={e.color || 'var(--border-soft)'}
                strokeWidth={isTether ? 1.5 : 1}
                strokeDasharray={isTether ? '4 3' : e.type === 'stage' ? '2 2' : undefined}
                opacity={0.65}
              />
            );
          })}
        </svg>
      )}

      <Canvas<CanvasNodeItem>
        items={items}
        itemId={(it) => it.id as ItemId}
        itemKind={(it) => it.kind}
        layout={effectiveLayout}
        viewport={viewport}
        editMode
        selectedId={(selectedNodeId as ItemId) ?? null}
        gridSnap={GRID_SNAP}
        renderItem={renderItem}
        onLayoutChange={handleLayoutChange}
        onViewportChange={handleViewportChange}
        onSelectionChange={handleSelectionChange}
        ariaLabel="Studio node canvas"
        className="h-full w-full"
      >
        {/* Honest status line: where layout is being written, and any failure. */}
        <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex items-center gap-2 rounded-md border border-soft bg-surface/90 px-2 py-1 font-mono text-[9px] text-fg-faint backdrop-blur">
          <span title="Authored layout is persisted to the project, not the browser">
            {persistMode === 'rpc'
              ? 'layout → .studio/canvas.json'
              : persistMode === 'local'
                ? 'layout → browser only (no project on disk)'
                : 'layout not persisted'}
          </span>
          {reorderBusy && <span className="text-[var(--info)]">writing order…</span>}
          {mutationBusy && <span className="text-[var(--info)]">writing cells…</span>}
          {/* A create/delete that resolved against the MOCK client succeeded —
              against the in-memory demo board, not disk. Say so: otherwise a
              degraded probe (studio MCP server slow / crash-looping) makes a
              create look like it landed, and the shot vanishes when the real
              client comes back on the next retry window. */}
          {demoWrite && !mutationBusy && (
            <span
              className="text-[var(--warning)]"
              title="This surface's last create/delete ran against the demo board. Nothing was written to storyboard.json — either there is no project on disk, or the studio MCP server did not answer its probe."
            >
              cells → demo board (not on disk)
            </span>
          )}
          {persistError && <span className="text-[var(--danger)]" title={persistError}>save failed</span>}
        </div>

        {/* G-61 b5 — create/delete failures are real MCP errors; say so rather
            than leaving a button that looks like it did nothing. */}
        {mutationError && (
          <div
            role="alert"
            className="pointer-events-auto absolute left-3 top-3 z-20 flex max-w-[min(420px,60%)] items-center gap-2 rounded-md border border-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_12%,var(--bg-surface))] px-2 py-1 font-mono text-[10px] text-[var(--danger)] shadow-md backdrop-blur"
          >
            <span className="truncate" title={mutationError}>{mutationError}</span>
            <button
              type="button"
              aria-label="Dismiss cell error"
              onClick={clearMutationError}
              className="ml-auto rounded border border-soft px-1 py-px text-fg-muted hover:text-fg"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Delete confirm — the Rail confirms before `storyboard.delete_cell`,
            so this surface does too rather than inventing a second policy, and
            through the same focus-trapped modal shape (see ConfirmDialog: a bare
            in-canvas div would leave Escape meaning "clear selection"). */}
        {confirmDelete && (
          <ConfirmDialog title="Delete cell" onClose={closeConfirm}>
            <h2 className="font-display text-[12px] font-semibold text-fg">Delete this cell?</h2>
            <p className="mt-1 text-[10px] leading-relaxed text-fg-muted">
              <span className="font-mono text-fg">{confirmDelete.beat}</span>{' '}
              <span className="font-mono text-fg-faint">({confirmDelete.uid})</span> will be removed
              from the storyboard. Its render files on disk are left in place.
            </p>
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                aria-label="Cancel delete cell"
                onClick={closeConfirm}
                className="rounded px-2 py-0.5 text-[10px] text-fg-muted hover:bg-raised hover:text-fg"
              >
                Cancel
              </button>
              <button
                type="button"
                aria-label="Confirm delete cell"
                disabled={mutationBusy}
                onClick={() => void deleteCell(confirmDelete.uid)}
                className="rounded bg-[color-mix(in_oklab,var(--danger)_18%,transparent)] px-2 py-0.5 text-[10px] text-[var(--danger)] ring-1 ring-inset ring-[color-mix(in_oklab,var(--danger)_40%,transparent)] hover:bg-[color-mix(in_oklab,var(--danger)_26%,transparent)] disabled:opacity-50"
              >
                {mutationBusy ? 'Deleting…' : 'Delete cell'}
              </button>
            </div>
          </ConfirmDialog>
        )}

        <div className="pointer-events-auto absolute bottom-3 right-3 z-10 flex items-center gap-1 rounded-md border border-soft bg-surface/90 p-1 backdrop-blur shadow-md font-mono text-[10px]">
          <button
            type="button"
            onClick={toggleLaneCollapsed}
            className={[
              'rounded px-2 py-0.5 border text-[10px]',
              doc.lane_collapsed ? 'border-[var(--achievement)] text-[var(--achievement)]' : 'border-soft text-fg-muted hover:text-fg',
            ].join(' ')}
            title="Collapse the sequence lane to a single strip (D-25-5)"
          >
            Lane {doc.lane_collapsed ? 'strip' : 'full'}
          </button>
          <button
            type="button"
            aria-label="New cell"
            disabled={mutationBusy}
            onClick={() => void createCellAtLaneEnd()}
            className="rounded border border-soft px-2 py-0.5 text-fg-muted hover:text-fg disabled:opacity-50"
            title="Add an empty cell at the end of the sequence lane (same defaults as the Rail's New cell)"
          >
            {mutationBusy ? 'Adding…' : '+ New cell'}
          </button>
          <button
            type="button"
            onClick={createGroup}
            className="rounded border border-soft px-2 py-0.5 text-fg-muted hover:text-fg"
            title="Create a group (containing the selected shot, if any). Groups are the only true container."
          >
            + Group
          </button>
          {activeGroup && (
            <button
              type="button"
              onClick={() => removeGroup(activeGroup.id)}
              className="rounded border border-soft px-2 py-0.5 text-fg-muted hover:text-[var(--danger)]"
              title="Delete this group. Its shots and their placements stay."
            >
              Ungroup
            </button>
          )}
          <div className="h-4 w-px bg-soft" />
          <button
            type="button"
            onClick={() => setShowEdges((v) => !v)}
            className={[
              'rounded px-2 py-0.5 border text-[10px]',
              showEdges ? 'border-[var(--info)] bg-[var(--info)] text-[var(--bg-base)]' : 'border-soft text-fg-muted hover:text-fg',
            ].join(' ')}
            title="Toggle connection edges"
          >
            Edges {showEdges ? 'ON' : 'OFF'}
          </button>
          <div className="h-4 w-px bg-soft" />
          <button
            type="button"
            onClick={() => setViewport((v) => ({ ...v, scale: Math.min(2.0, v.scale * 1.2) }))}
            className="h-6 w-6 rounded hover:bg-raised text-fg flex items-center justify-center font-bold"
            title="Zoom in"
          >
            +
          </button>
          <span className="px-1 text-fg-muted tabular-nums">{Math.round(viewport.scale * 100)}%</span>
          <button
            type="button"
            onClick={() => setViewport((v) => ({ ...v, scale: Math.max(0.25, v.scale / 1.2) }))}
            className="h-6 w-6 rounded hover:bg-raised text-fg flex items-center justify-center font-bold"
            title="Zoom out"
          >
            -
          </button>
          <button
            type="button"
            onClick={() => setViewport(() => DEFAULT_VIEWPORT)}
            className="rounded px-2 py-0.5 hover:bg-raised text-fg-muted hover:text-fg"
            title="Reset viewport"
          >
            Reset
          </button>
        </div>
      </Canvas>
    </div>
  );
}

export default NodeCanvas;
