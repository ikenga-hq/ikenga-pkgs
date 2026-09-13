// com.ikenga.studio · Canvas view
//
// The node canvas is the Canvas view. The 1D Rail — a document-flow board of
// wrapping shot cards under a project-wide forge-progress rail, and the
// "Canvas"/"Rail" tablist that chose between them — was RETIRED in WP-31, after
// the G-61 live re-clear (behaviours 1–6 all PASS; see the meta-repo file
// `plans/studio/verify/2026-09-12-wp32-live/g61/7-gate.md` §0, 2026-09-13).
// `<NodeCanvas />` now renders unconditionally inside this view's chrome.
//
// What this file still owns is the VIEW CHROME around that surface:
//   • the project banner — name, archetype, and an aspect chip carrying the
//     boarded duration + shot count (real `duration_ms`, summed; no fabricated
//     figures, and no money anywhere: fal reports no cost field for the models
//     this account runs, so any figure here would be fiction — spend, if the
//     engine ever reports it, belongs in the Ledger view);
//   • the card-density switch (the shell's grid/loupe idiom, per project),
//     `Refresh anchors`, and `Forge all remaining`;
//   • the error banner that real MCP create failures surface through;
//   • `+ New cell` and its focus-trapped create modal. This is the only
//     LABELLED create path in the product — the canvas toolbar's own
//     `+ New cell` writes an unlabelled lane cell — and it shares the node
//     canvas's end-of-lane arithmetic (`nextLaneIndex`, G-103) so the two
//     surfaces cannot disagree about a new shot's index.
//
// Rung: `rung` is how a shot is MADE, not how finished it is. What it gates
// here is the generation surface: only a hi-fi cell has a fal path to run, so
// `Forge all remaining` counts hi-fi cells only.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { selectCellUid, useSharedStore } from '../shared-state';
import { useProjectStore, selectOpenProject } from '../project-store';
import {
  useStoryboardStore,
  selectHydratedCells,
  selectHasRealCells,
  selectRenderStatus,
} from '../storyboard-store';
import { useLayoutStore } from '../layout-store';
import { useAnchorsStore } from '../anchors-store';
import { storyboardApi } from '../mcp-client';
import { useAsyncAction } from '../lib/use-async-action';
import { useShotGenerate } from '../lib/use-shot-generate';
import { NodeCanvas } from './NodeCanvas';
import type { AspectRatio, Cell, Rung } from '../mcp-types';
import { rungDir } from '../mcp-types';
import { nextLaneIndex } from '../lib/canvas-model';

// ─── Density ────────────────────────────────────────────────────────────
//
// `strip` is the compact board; `loupe` is the judging density. Mirrors the
// shell's grid/loupe idiom, and rides on the view root as
// `data-canvas-density` for the surfaces below to read.
//
// NOT spelled `data-density` on the DOM: theme.ts mirrors the shell's OWN
// `data-density` (compact/comfortable chrome density) onto <html>, and a
// same-named attribute here would read as the same axis.

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

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return `${s % 1 === 0 ? s.toFixed(0) : s.toFixed(1)}s`;
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'beat';
const rnd = () => Math.random().toString(36).slice(2, 8);

// ─── Focus-trapped modal (new cell) ─────────────────────────────────────

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

// ─── View ───────────────────────────────────────────────────────────────

export function CanvasView() {
  const selectedCellUid = useSharedStore(selectCellUid);
  const setCellUid = useSharedStore((s) => s.setCellUid);

  const project = useProjectStore(selectOpenProject);
  const projectId = project?.project_id ?? null;
  const aspect: AspectRatio = project?.aspect_ratio ?? '16:9';

  // Density is a per-project preference — a vertical-video project and a 16:9
  // explainer want different defaults, and the choice should survive the pane's
  // remount the same way Cell.tsx's draft mirror does.
  const [density, setDensityState] = useState<Density>(() => readDensity(projectId));
  useEffect(() => { setDensityState(readDensity(projectId)); }, [projectId]);
  const setDensity = (d: Density) => {
    setDensityState(d);
    try { localStorage.setItem(densityStorageKey(projectId), d); } catch { /* best-effort */ }
  };

  // add-cell + error UI — the create busy/error pair rides the shared
  // useAsyncAction, which also carries the forge-all failure message.
  const [addOpen, setAddOpen] = useState(false);
  const [newBeat, setNewBeat] = useState('');
  const [newRung, setNewRung] = useState<Rung>('2_hifi');
  const cellMutation = useAsyncAction();
  const busy = cellMutation.busy;
  const error = cellMutation.error;
  const [forgeError, setForgeError] = useState<string | null>(null);
  const [forging, setForging] = useState(false);

  // Cells come from the storyboard store — the schema array the create RPC
  // appends to, real cells in real mode and the mock MCP's own cells in demo
  // mode. Deliberately NOT the `__mocks__/cells.ts` PRESENTATION fixture the
  // retired Rail fell back to: that list has no `index`, is 10 entries long on
  // a real project with zero cells, and nothing that WRITES may read it
  // (G-103).
  const hydratedCells = useStoryboardStore(selectHydratedCells);
  const hasRealCells = useStoryboardStore(selectHasRealCells);
  const renderStatusMap = useStoryboardStore(selectRenderStatus);
  const refreshRenders = useStoryboardStore((s) => s.refreshRenders);
  const bumpActivePoll = useStoryboardStore((s) => s.bumpActivePoll);
  const refetchStoryboard = useStoryboardStore((s) => s.refetch);

  useEffect(() => { void refetchStoryboard(); }, [refetchStoryboard]);

  // The aspect chip's "~Ns" is the sum of the boarded cells' real duration_ms.
  const boardDurationMs = useMemo(
    () => hydratedCells.reduce((sum, c) => sum + (c.duration_ms ?? 0), 0),
    [hydratedCells],
  );
  const shotCount = hydratedCells.length;

  // Anchors resolve id → name/kind for the node canvas's ref chips. Shared
  // store (review §2.4) — an unreachable anchor.list just leaves chips showing
  // the raw id.
  const ensureAnchors = useAnchorsStore((s) => s.ensure);
  const refreshAnchors = useAnchorsStore((s) => s.refresh);
  useEffect(() => {
    if (project?.project_id) ensureAnchors(project.project_id);
  }, [project?.project_id, ensureAnchors]);

  // "Remaining Track A" — every hi-fi cell that isn't already rendered or in
  // flight. Track is rung-derived: a lo-fi cell is an excalidraw drawing and a
  // beat sheet is text, so neither has a prompt to send to fal.
  const remainingTrackA = useMemo(
    () =>
      hydratedCells.filter((c) => {
        if (c.rung !== '2_hifi') return false;
        const st = renderStatusMap[c.uid];
        return st !== 'done' && st !== 'running';
      }),
    [hydratedCells, renderStatusMap],
  );

  // The shared shot-generate pipeline. It owns the engine capability + enqueue
  // + Track-B legs, so the engine is resolved against the server's reported
  // matrix rather than a hardcoded 'fal'.
  const shot = useShotGenerate(selectedCellUid, {
    isReal: hasRealCells,
    projectId: project?.project_id ?? null,
    onEnqueued: () => bumpActivePoll(),
  });

  // Sequential, not Promise.all — each leg refetches the storyboard, and firing
  // N enqueues at once would race those refetches against each other.
  async function forgeAllRemaining() {
    if (forging) return;
    setForging(true);
    setForgeError(null);
    try {
      for (const c of remainingTrackA) {
        await shot.enqueueRender(c.uid, { engine: shot.resolveTrackAEngineId('fal') });
      }
      await Promise.all([refetchStoryboard(), refreshRenders()]);
    } catch (err) {
      setForgeError(`Forge failed — ${(err as Error).message}`);
    } finally {
      setForging(false);
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
      // The arithmetic: `nextLaneIndex` = max(maxIndex + 1, length) is correct
      // on both a gapped board (the sidecar's delete does not reindex) and a
      // fresh scaffold (every index 0 there, where max + 1 alone would
      // collide).
      //
      // The board: `hydratedCells` — the array `storyboard.create_cell`
      // actually appends to on both boards — so the two surfaces agree by
      // construction and not by coincidence.
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

  const banner = error ?? forgeError;

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
            {` · ${shotCount} shot${shotCount === 1 ? '' : 's'}`}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
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
            onClick={() => void refreshAnchors()}
            className="rounded border border-[var(--border)] px-2 py-1 text-fg-muted hover:border-[var(--fg-faint)] hover:text-fg"
          >
            Refresh anchors
          </button>
          <button
            type="button"
            onClick={() => { cellMutation.clearError(); setForgeError(null); setAddOpen(true); }}
            className="rounded px-2 py-1 text-fg-muted hover:bg-raised hover:text-fg"
          >
            + New cell
          </button>
          <button
            type="button"
            disabled={forging || remainingTrackA.length === 0}
            onClick={() => void forgeAllRemaining()}
            title="Enqueue every Track-A shot that isn't already forged or running"
            className="rounded border border-[color-mix(in_oklab,var(--achievement)_60%,transparent)] bg-[color-mix(in_oklab,var(--achievement)_18%,transparent)] px-3 py-1 text-[12px] font-medium text-[var(--achievement)] shadow-[0_0_0_1px_color-mix(in_oklab,var(--achievement)_18%,transparent)] hover:bg-[color-mix(in_oklab,var(--achievement)_26%,transparent)] disabled:opacity-40"
          >
            {forging ? 'Queuing…' : `Forge all remaining · ${remainingTrackA.length} shot${remainingTrackA.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </header>

      {/* Error banner — real MCP create / forge failures surface here. */}
      {banner && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 border-b border-[var(--beat-accent-rose-border,var(--danger))] bg-[color-mix(in_oklab,var(--danger)_12%,var(--bg-sunken))] px-3 py-1.5 text-[11px] text-[var(--danger)]"
        >
          <span className="truncate">{banner}</span>
          <button
            type="button"
            onClick={() => { cellMutation.clearError(); setForgeError(null); }}
            className="rounded px-1.5 py-0.5 text-fg-muted hover:bg-raised hover:text-fg"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* The surface. WP-31: the node canvas is the Canvas view — there is no
          second surface and no switch. */}
      <div className="min-h-0 flex-1">
        <NodeCanvas />
      </div>

      {/* New cell dialog — the only LABELLED create path in the product. */}
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
    </section>
  );
}
