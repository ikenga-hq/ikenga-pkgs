// com.ikenga.studio · Cell view — CE-A "editor + living preview" (Wave 3)
//
// Concept: designs/redesign/cell-a-living-preview.html + the CE-C strip graft
// (cell-c-strip-context.html). A persistent all-cells strip (beat + status dot
// + rung) sits above a split of a CodeMirror source editor and a preview that
// plays the REAL rendered cell. Selecting a cell from the strip switches the
// edited cell without ever leaving the view — the old "No cell selected" dead
// end is gone.
//
// REAL seams (no fixture in real mode):
//   • Editor content — storyboard.read_cell_content reads the cell's actual
//     content.html off disk (the Cell record only points to it). The mock is
//     used ONLY in standalone/mock mode.
//   • Save — storyboard.write_cell_content persists the FULL edited html back
//     to content.html (durable; the render runner reads the same file). Explicit
//     Save button + Cmd/Ctrl-S + a dirty dot; per-cell buffers survive cell
//     switches AND view remounts so an unsaved edit is never silently dropped.
//     Failures surface as a retryable error banner that keeps the buffer.
//   • Preview — the rendered cell's real mp4 (renderApi.read_bytes → blob:,
//     the Wave-2 pattern). Un-rendered cells show an honest empty state with a
//     "Render this cell" action wired to the real composition.render enqueue +
//     adaptive poll; NO hand-coded mock preview in real mode. Progress is an
//     honest indeterminate bar — the sidecar reports no true percentage.
//   • Anchors — anchor.list (real project anchors) drives the drawer; the
//     fixture is kept only for standalone. Inserting a tile drops
//     <img data-anchor="…"> at the cursor via the anchor-insert extension.
//   • Narration — real check off the cell's narration_excerpt / the project
//     narration block. When absent, an honest note (with a Chi hint) stands in
//     for a dead toggle.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CodeEditor, type CodeEditorHandle } from '@ikenga/ui-lib';
import { insertAnchor } from '@ikenga/ui-lib/extensions';

import {
  getCellHtml,
  getNarrationExcerpt,
  setCellHtmlOverride,
  MOCK_CELLS,
  MOCK_ANCHORS,
  type CellColor,
} from '../__mocks__/cells';
import { selectCellUid, selectPlayheadMs, useSharedStore } from '../shared-state';
import { useProjectStore, selectOpenProject } from '../project-store';
import {
  useStoryboardStore,
  selectHydratedCells,
  selectHydratedProject,
  selectHasRealCells,
  selectRenderStatus,
  selectRenderRecords,
  toDisplayCell,
} from '../storyboard-store';
import { useAnchorsStore, selectAnchors } from '../anchors-store';
import {
  getMcpClient,
  storyboardApi,
  renderApi,
} from '../mcp-client';
import { useAsyncAction } from '../lib/use-async-action';
import { buildDraftDoc } from '../lib/draft-doc';
import { useShotGenerate, type RenderOpts } from '../lib/use-shot-generate';
import { recordByUid, fmtRelative, base64ToBlob, copyText, engineLabel } from './composition/format';
import type { CellVideoAvailability } from './composition/CellVideo';
import { DEFAULT_RESOLUTION } from '../mcp-types';
import type { Rung, AspectRatio, RenderStatus, EngineCapability, PromptPackage, RenderRecord } from '../mcp-types';
import { EmptyState } from '../components/EmptyState';
import { SafeZones, useRememberedToggle } from '../media-controls';

// ─── palette (warm Dusk-Wood role tokens; no hex fallbacks — canvas theme fix) ─

const COLOR_VAR: Record<CellColor, string> = {
  amber: '--achievement',
  rose: '--danger',
  emerald: '--live',
  sky: '--info',
  violet: '--agent',
  neutral: '--fg-muted',
};

function roleTint(color: CellColor, pct: number): string {
  return `color-mix(in oklab, var(${COLOR_VAR[color]}) ${pct}%, transparent)`;
}

const RUNG_ORDER: Rung[] = ['0_beat_sheet', '1_lofi', '2_hifi'];
const RUNG_SHORT: Record<Rung, string> = {
  '0_beat_sheet': 'Beat sheet',
  '1_lofi': 'Lo-fi',
  '2_hifi': 'Hi-fi',
};
const RUNG_LABEL: Record<Rung, string> = {
  '2_hifi': 'hifi',
  '1_lofi': 'lofi',
  '0_beat_sheet': 'beat sheet',
};
const RUNG_DIR: Record<Rung, string> = {
  '2_hifi': 'hifi',
  '1_lofi': 'lofi',
  '0_beat_sheet': 'beatsheet',
};

// The size the renderers actually draw at (hyperframes' resolveResolution →
// DEFAULT_RESOLUTION). Read from the schema rather than restated here: this
// number is both shown to the user and used to lay the draft out, so a local
// copy drifting from the frame would make the draft lie about its geometry.
function aspectRes(a: AspectRatio): string {
  const { w, h } = DEFAULT_RESOLUTION[a];
  return `${w}×${h}`;
}

// The frame a composition declares for itself. hyperframes' render() resolves
// `opts.aspect_ratio ?? contentDeclaredAspect(content) ?? project aspect`, so a
// portrait-authored cell in a 16:9 project renders PORTRAIT — the content beats
// the project. Same semantics as that reader (hyperframes.ts:189), deliberately
// down to the double-quoted-digits regex: a dim it cannot parse is a dim the
// renderer does not honour either, and only both dims together declare a frame.
const DECLARED_W = /data-width="(\d+)"/;
const DECLARED_H = /data-height="(\d+)"/;

function declaredAspect(html: string): AspectRatio | undefined {
  const w = Number(DECLARED_W.exec(html)?.[1]);
  const h = Number(DECLARED_H.exec(html)?.[1]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return undefined;
  if (w === h) return '1:1';
  return h > w ? '9:16' : '16:9';
}

function previewFrameStyle(aspect: AspectRatio): React.CSSProperties {
  if (aspect === '9:16') return { height: '100%', aspectRatio: '9 / 16', maxWidth: '100%' };
  if (aspect === '1:1') return { height: '100%', aspectRatio: '1 / 1', maxWidth: '100%' };
  return { width: '100%', height: '100%' };
}

// ─── unified strip cell shape (real hydrated OR mock fixture) ────────────

interface StripCell {
  uid: string;
  beat: string;
  rung: Rung;
  color: CellColor;
  block_id?: string;
  /** Real cells only (Cell.duration_ms). The mock fixture carries no timing,
   *  so the strip sub-row simply omits it rather than inventing a number. */
  duration_ms?: number;
}

// ─── per-cell edit buffers (module-level → survive view remount) ─────────
//
// Keyed by `${projectId}::${uid}` so an unsaved edit is preserved across cell
// switches AND across leaving/re-entering the Cell pane, never silently
// discarded. `saved*` track the last-persisted content so the dirty dot is
// truthful. These are the P1 stand-in for the shell relaying a cells/changed
// event; a save writes through to disk immediately (write_cell_content).

const editBuffers = new Map<string, string>();
const savedContent = new Map<string, string>();
const savedAtMap = new Map<string, number>();
// Save failures are per-cell too. saveState is a single view-level state and
// the view never remounts on a cell switch, so a failure that resolves after
// the user has moved on must be parked against the cell it belongs to — not
// stamped onto whatever cell happens to be open — and restored when they come
// back to it, so the retry banner is never silently lost.
const saveErrors = new Map<string, string>();
const bufKey = (pid: string | null, uid: string) => `${pid ?? 'mock'}::${uid}`;

// ─── localStorage draft mirror (survives the pane's OWN remount) ─────────
//
// The module-level Maps above are still per-mount: the shell remounts the
// whole pkg iframe on every pane switch, which re-evaluates this module from
// scratch and wipes them along with everything else in the destroyed JS
// context. localStorage is same-origin-stable across that remount (srcdoc
// inherits the parent origin), so it is the actual durable layer — the Maps
// are just this mount's in-memory cache over it. Keyed by the same bufKey
// string so `studio:draft:<projectId>::<cellUid>` is exactly the key the rest
// of the file already reasons about. Only DIRTY content is ever written —
// content matching the last-known disk baseline has nothing worth restoring
// and is actively removed so a stale entry can't outlive its own draft.
const DRAFT_STORAGE_PREFIX = 'studio:draft:';
const draftStorageKey = (key: string) => `${DRAFT_STORAGE_PREFIX}${key}`;

interface PersistedDraft { content: string; savedContent: string; ts: number; }

function readPersistedDraft(key: string): PersistedDraft | null {
  try {
    const raw = localStorage.getItem(draftStorageKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedDraft>;
    if (typeof parsed.content !== 'string' || typeof parsed.savedContent !== 'string') return null;
    return { content: parsed.content, savedContent: parsed.savedContent, ts: parsed.ts ?? 0 };
  } catch {
    // Disabled/quota-exceeded storage, or corrupt JSON from an older shape —
    // either way there is nothing safe to restore, not a reason to throw.
    return null;
  }
}

function writePersistedDraft(key: string, content: string, baseline: string): void {
  try {
    if (content === baseline) { localStorage.removeItem(draftStorageKey(key)); return; }
    localStorage.setItem(draftStorageKey(key), JSON.stringify({ content, savedContent: baseline, ts: Date.now() }));
  } catch {
    // Best-effort — the in-memory buffer still works for this mount.
  }
}

function clearPersistedDraft(key: string): void {
  try { localStorage.removeItem(draftStorageKey(key)); } catch { /* best-effort */ }
}

/** True if ANY open buffer this mount has touched differs from its saved
 *  baseline — drives the beforeunload guard, independent of which cell (if
 *  any) is on screen right now. */
function anyDraftDirty(): boolean {
  for (const [key, content] of editBuffers) {
    if (content !== savedContent.get(key)) return true;
  }
  return false;
}

/** Immediate (non-debounced) flush of every buffer this mount knows about —
 *  used on pagehide/visibilitychange, where a pending debounce timer would
 *  simply never fire. */
function flushAllDrafts(): void {
  for (const [key, content] of editBuffers) {
    const baseline = savedContent.get(key);
    if (baseline === undefined) continue;
    writePersistedDraft(key, content, baseline);
  }
}

// Debounced per-key flush so every keystroke doesn't hit localStorage — only
// module-scope (not component state) because editBuffers itself is.
const draftFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DRAFT_FLUSH_DEBOUNCE_MS = 500;

function scheduleDraftFlush(key: string): void {
  const existing = draftFlushTimers.get(key);
  if (existing) clearTimeout(existing);
  draftFlushTimers.set(key, setTimeout(() => {
    draftFlushTimers.delete(key);
    const content = editBuffers.get(key);
    const baseline = savedContent.get(key);
    if (content === undefined || baseline === undefined) return;
    writePersistedDraft(key, content, baseline);
  }, DRAFT_FLUSH_DEBOUNCE_MS));
}

function cancelDraftFlush(key: string): void {
  const t = draftFlushTimers.get(key);
  if (t) { clearTimeout(t); draftFlushTimers.delete(key); }
}

// ─── rendered-cell preview (reuses the Wave-2 read_bytes → blob pattern) ──
//
// bytes-over-bridge → Blob → blob: is the one media scheme the sandboxed
// srcdoc pane's CSP allows (see CellVideo header). Native <video controls> is
// the right affordance for reviewing a single cell (scrub / play / volume).
// Degrades honestly: a running server that predates render.read_bytes (or mock
// mode) returns empty base64 → we report 'unavailable' and the parent shows
// the status fallback instead of ever faking a player.

function RenderedCellVideo({
  recordId,
  onState,
}: {
  recordId: string;
  onState: (s: CellVideoAvailability) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    onStateRef.current('loading');
    (async () => {
      try {
        const client = await getMcpClient();
        const bytes = await renderApi.read_bytes(client, recordId);
        if (cancelled) return;
        if (!bytes.base64) {
          setSrc(null);
          onStateRef.current('unavailable');
          return;
        }
        url = URL.createObjectURL(base64ToBlob(bytes.base64, bytes.mime));
        setSrc(url);
      } catch {
        if (!cancelled) {
          setSrc(null);
          onStateRef.current('error');
        }
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [recordId]);

  if (!src) return null;
  return (
    <video
      src={src}
      controls
      playsInline
      preload="auto"
      className="h-full w-full object-contain"
      onCanPlay={() => onStateRef.current('ready')}
      onError={() => onStateRef.current('error')}
      aria-label="Rendered cell preview"
    />
  );
}

// ─── draft preview (CE-A's namesake — an approximation, never the frame) ──
//
// Draws the editor buffer's frame-0 DOM into a sandboxed srcdoc pane so an
// un-rendered cell isn't a dead stage while you author it. Everything about it
// is deliberately weaker than the mp4, and the UI says so rather than letting
// the two blur:
//   • srcdoc gets a NULL origin, so it cannot reach the fonts this pkg inlines
//     into its own document — the cell's real typefaces are simply not there
//     and headings fall back to a system face.
//   • The pkg CSP governs the child, so nothing remote loads. Nothing here may
//     depend on the network (the CE-A mockup's <link> to Google Fonts is the
//     one thing from it that must NOT be carried over).
//   • A relative URL has nothing to resolve against either — the draft is the
//     BUFFER, not the cell's directory — so a <link> stylesheet or an
//     <img src="./plate.png"> that the frame draws fine is simply absent here.
//   • sandbox="" also means no scripts, so a cell that animates or measures
//     itself renders only its static first paint.
// What survives is what the buffer carries inline — its own <style>, its markup,
// a data: URI. The disclosure under the stage is written to that line and must
// not drift past it. The rendered mp4 stays authoritative wherever one exists;
// this augments it.

// The builder itself lives in `../lib/draft-doc` — the node canvas's live-HTML
// node (Plan 25 ladder row 3) renders through the SAME path rather than a
// second, weaker one of its own. `sandbox=""` below is the only sandbox value
// that may be paired with it.

function DraftPreview({ html, ready, aspect }: { html: string; ready: boolean; aspect: AspectRatio }) {
  const { w: compW, h: compH } = DEFAULT_RESOLUTION[aspect];
  const hostRef = useRef<HTMLDivElement>(null);
  // The render draws at composition resolution; this stage is a few hundred
  // CSS px. An iframe sized to the STAGE would lay a px-authored cell out at a
  // width the frame never has — different wrapping, different everything — so
  // the geometry, the one thing a draft can be faithful about, would be the
  // part it got wrong. The viewport is the frame's true size; only the
  // presentation is scaled.
  //
  // The offset is not cosmetic bookkeeping: the stage is only frame-shaped for
  // 9:16 and 1:1, and the cell's frame need not be the stage's shape at all, so
  // there is real leftover room. The mp4 beside this is object-contain, which
  // CENTRES in it — pinning the scaled draft at the origin instead made the
  // Rendered↔Draft toggle throw the content across the stage, which reads as a
  // broken pane rather than as the swap it is. Contain + centre is that same
  // rule done by hand, because a transform is what the scaling needs.
  const [fit, setFit] = useState<{ scale: number; x: number; y: number } | null>(null);
  useEffect(() => {
    const el = hostRef.current;
    if (!el) { setFit(null); return; }
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r || r.width === 0 || r.height === 0) return;
      const scale = Math.min(r.width / compW, r.height / compH);
      setFit({ scale, x: (r.width - compW * scale) / 2, y: (r.height - compH * scale) / 2 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready, compW, compH]);

  if (!ready) {
    return (
      <div className="grid place-items-center gap-1 px-4 text-center">
        <div className="text-[13px] text-fg-muted">Nothing to draft yet</div>
        <div className="max-w-[18rem] font-mono text-[10px] leading-relaxed text-fg-faint">
          the draft preview draws this cell's source — it loads first
        </div>
      </div>
    );
  }
  return (
    <>
      <div ref={hostRef} className="absolute inset-0 overflow-hidden">
        {fit && fit.scale > 0 && (
          <iframe
            title="Draft preview of this cell's HTML"
            srcDoc={buildDraftDoc(html)}
            sandbox=""
            // `block` so the offset below is measured from the host's corner and
            // not from an inline line-box the maths knows nothing about.
            className="block border-0"
            style={{
              width: compW,
              height: compH,
              transform: `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})`,
              transformOrigin: 'top left',
            }}
          />
        )}
      </div>
      <span
        className="cell-draft-badge pointer-events-none absolute left-2 top-2 z-10 rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider"
        style={{
          background: 'color-mix(in oklab, var(--bg-sunken) 82%, transparent)',
          color: 'var(--fg-muted)',
          border: '1px solid var(--border-soft)',
        }}
      >
        Draft preview
      </span>
    </>
  );
}

// Nominal narration window for the excerpt highlight (P1 stand-in for real
// per-word timing when sync is on).
const NARRATION_WINDOW_MS = 3200;

// ─── Generate tab (production-desk graft) ────────────────────────────────
//
// Prompt text for the STANDALONE/MOCK fixture only ("The Forge" · sc1_sh2 ·
// Adaora at the anvil) so the demo desk has something to look at. A real
// project's cell never gets seeded with it: an unauthored Cell.prompt starts
// empty, because persistGenPatch writes the prompt straight to the user's
// cell on disk and a render spends money on it — text the user did not write
// must never reach either.
const FIXTURE_PROMPT_SEED =
  "Adaora at the anvil, hammer raised overhead, firelight catching the sweat on her brow — " +
  'mid-strike stillness before the blow. Ember-noir lighting, warm orange key against deep ' +
  'shadow, cinematic shallow depth of field. The Workshop behind her, forge glowing.';

const HANDOFF_ENGINE_ID = 'higgsfield';

// fal is the one Track-A adapter with a model choice (renderers/fal.ts →
// resolveVideoModel reads opts.variant first). Same short names + same
// `variant` threading as the Canvas per-shot picker — one pattern, one call.
const FAL_ENGINE_ID = 'fal';
// '' is Auto and MUST send no variant at all. resolveVideoModel treats ANY
// variant as a deliberate override that wins over the cell's own
// metadata.fal_model / FAL_VIDEO_MODEL and, critically, suppresses its
// fromDefault branch — the one that swaps in the image-to-video sibling when
// the cell has an anchor plate. A picker that always sends its default would
// silently stop anchors conditioning the shot (or 422 the call), which is the
// whole reason this surface exists. Only an explicit pick may override.
const FAL_MODEL_AUTO = '';
const FAL_MODELS = ['ltx-video', 'flux', 'flux-i2v'] as const;

// The draft preview mirrors CodeMirror's buffer, which changes on every
// keystroke; re-mounting a srcdoc pane that often thrashes. First paint after
// a mode switch is immediate, subsequent edits settle.
const DRAFT_PREVIEW_DEBOUNCE_MS = 400;

function randomSeed(): number {
  return Math.floor(100_000 + Math.random() * 899_999);
}

// The only reader of `playheadMs` in this view (review §2.6): subscribing at
// the top of CellView re-rendered its ~1800-line tree every playback frame
// for a highlight only this row paints. Pushed down here — and memoized —
// so a per-frame update stays scoped to this strip instead of the whole view.
const NarrationRow = memo(function NarrationRow({
  narrationText,
  narrationStaticIdx,
}: {
  narrationText: string | null;
  narrationStaticIdx: number;
}) {
  const [narrationSync, setNarrationSync] = useState(false);
  const playheadMs = useSharedStore(selectPlayheadMs);
  const narrationActiveIdx = (() => {
    if (!narrationText) return 0;
    if (!narrationSync) return narrationStaticIdx;
    const wordCount = narrationText.trim().split(/\s+/).length;
    if (wordCount === 0) return 0;
    const phase = ((playheadMs % NARRATION_WINDOW_MS) + NARRATION_WINDOW_MS) % NARRATION_WINDOW_MS;
    return Math.min(wordCount - 1, Math.floor((phase / NARRATION_WINDOW_MS) * wordCount));
  })();

  return (
    <div className="flex items-center gap-3 border-t border-soft bg-surface px-3 py-2 text-[11px]">
      {narrationText ? (
        <>
          <button
            type="button"
            onClick={() => setNarrationSync((s) => !s)}
            aria-pressed={narrationSync}
            className={
              'flex flex-none items-center gap-1.5 rounded px-2 py-1 ' +
              (narrationSync ? 'bg-raised text-fg' : 'text-fg-muted hover:bg-raised hover:text-fg')
            }
            title="Sync the narration highlight to the composition playhead"
          >
            <span>▸ Narration</span>
          </button>
          <div className="min-w-0 flex-1 leading-relaxed text-fg-muted">
            {narrationText.split(/(\s+)/).map((tok, i) => {
              if (/^\s+$/.test(tok)) return tok;
              const wordIdx =
                narrationText.slice(0, narrationText.indexOf(tok) + tok.length).split(/\s+/).length - 1;
              const active = wordIdx === narrationActiveIdx;
              return (
                <span
                  key={`${i}-${tok}`}
                  className={active ? 'font-medium' : 'opacity-60'}
                  style={active ? { color: 'var(--achievement)' } : undefined}
                >
                  {tok}
                </span>
              );
            })}
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2 text-fg-muted">
          <span className="opacity-40">▸ Narration</span>
          <span className="text-[11px]">
            No narration on this cell yet — ask your Chi in chat to add voiceover.
          </span>
        </div>
      )}
    </div>
  );
});

// ─── View ───────────────────────────────────────────────────────────────

export function CellView() {
  const cellUid = useSharedStore(selectCellUid);
  const setCellUid = useSharedStore((s) => s.setCellUid);
  const project = useProjectStore(selectOpenProject);

  const hasRealCells = useStoryboardStore(selectHasRealCells);
  const hydratedCells = useStoryboardStore(selectHydratedCells);
  const projectDoc = useStoryboardStore(selectHydratedProject);
  const renderStatus = useStoryboardStore(selectRenderStatus);
  const renderRecords = useStoryboardStore(selectRenderRecords);
  const refetchStoryboard = useStoryboardStore((s) => s.refetch);
  const refreshRenders = useStoryboardStore((s) => s.refreshRenders);
  const bumpActivePoll = useStoryboardStore((s) => s.bumpActivePoll);

  const pid = hasRealCells ? project?.project_id ?? null : null;

  // The shared shot-generate pipeline — engine capability, the primary cell's
  // render lifecycle (enqueue + poll), and the Track-B handoff/ingest legs.
  // Presentation stays in this view; the action pipeline lives in the hook.
  const shot = useShotGenerate(cellUid, {
    isReal: hasRealCells,
    projectId: project?.project_id ?? null,
    onEnqueued: () => bumpActivePoll(),
    onSettled: () => { void refreshRenders(); },
  });
  const trackAEngines = shot.trackAEngines;

  // Re-read on focus (POLL-on-demand stand-in for cells/changed).
  useEffect(() => { void refetchStoryboard(); }, [refetchStoryboard]);

  // Strip source: real hydrated cells, else the mock fixture.
  const stripCells = useMemo<StripCell[]>(() => {
    if (hasRealCells) {
      return hydratedCells.map((c) => {
        const d = toDisplayCell(c);
        return {
          uid: d.uid,
          beat: d.beat,
          rung: d.rung,
          color: d.color,
          block_id: d.block_id,
          duration_ms: d.raw.duration_ms,
        };
      });
    }
    return MOCK_CELLS.map((c) => ({
      uid: c.uid,
      beat: c.beat,
      rung: c.rung,
      color: c.color,
      block_id: c.block_id,
    }));
  }, [hasRealCells, hydratedCells]);

  const cell = useMemo<StripCell | null>(
    () => stripCells.find((c) => c.uid === cellUid) ?? null,
    [stripCells, cellUid],
  );
  const rawCell = useMemo(
    () => (hasRealCells ? hydratedCells.find((c) => c.uid === cellUid) ?? null : null),
    [hasRealCells, hydratedCells, cellUid],
  );

  // ── editor content + save state ──
  const [value, setValue] = useState('');
  // Which cell `value` holds. A selection change re-renders before the load
  // effect below runs, so for that pass `value` is still the PREVIOUS cell's
  // source — any surface that attributes the buffer to a cell must check this
  // first, or it paints one cell's content under another's name.
  const [valueUid, setValueUid] = useState<string | null>(null);
  const [contentState, setContentState] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  // Which cell (if any) just had its buffer seeded from a localStorage draft
  // instead of the freshly-read disk content — drives the "unsaved draft
  // restored" notice. Cleared on every cell (re)load and on discard.
  const [draftRestoredFor, setDraftRestoredFor] = useState<string | null>(null);
  const editorRef = useRef<CodeEditorHandle>(null);
  // Reads the cell that is open *now*, so an in-flight save can tell whether
  // the selection moved out from under it while its writes were awaiting.
  const cellUidRef = useRef(cellUid);
  cellUidRef.current = cellUid;

  // Load the active cell's content — reuse a preserved buffer if present
  // (same-mount cell revisit), else read the REAL content.html (real) / the
  // mock fixture (standalone) and reconcile it against any dirty draft a
  // PREVIOUS mount of this pane left in localStorage.
  useEffect(() => {
    if (!cellUid) { setContentState('idle'); return; }
    setDraftRestoredFor(null);
    const key = bufKey(pid, cellUid);
    if (editBuffers.has(key)) {
      // Already reconciled once this mount (the branch below ran already) —
      // the persisted-draft check only needs to happen on first load per key.
      const buf = editBuffers.get(key)!;
      setValue(buf);
      setValueUid(cellUid);
      setContentState('ready');
      const parked = saveErrors.get(key);
      setSaveError(parked ?? null);
      if (parked) setSaveState('error');
      else setSaveState(buf !== savedContent.get(key) ? 'dirty' : 'saved');
      return;
    }
    let cancelled = false;
    setSaveError(null);

    // freshHtml is always the true current disk/fixture baseline. A persisted
    // draft whose content differs from it wins the buffer (an unsaved edit a
    // prior mount could not flush anywhere but localStorage must never be
    // silently dropped for the freshly-read content); one that matches it is
    // stale and simply cleared.
    const settle = (freshHtml: string) => {
      if (cancelled) return;
      const persisted = readPersistedDraft(key);
      const initial = persisted && persisted.content !== freshHtml ? persisted.content : freshHtml;
      if (persisted && persisted.content === freshHtml) clearPersistedDraft(key);
      editBuffers.set(key, initial);
      savedContent.set(key, freshHtml);
      setValue(initial);
      setValueUid(cellUid);
      setContentState('ready');
      if (persisted && persisted.content !== freshHtml) {
        setSaveState('dirty');
        setDraftRestoredFor(cellUid);
      } else {
        setSaveState('saved');
      }
    };

    if (!hasRealCells) {
      settle(getCellHtml(cellUid));
      return;
    }
    setContentState('loading');
    (async () => {
      try {
        const client = await getMcpClient();
        const res = await storyboardApi.read_cell_content(client, cellUid);
        if (cancelled) return;
        settle(res.html ?? '');
      } catch (err) {
        if (cancelled) return;
        setContentState('unavailable');
        setSaveError((err as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [cellUid, hasRealCells, pid]);

  const onEditorChange = useCallback((next: string) => {
    setValue(next);
    if (!cellUid) return;
    const key = bufKey(pid, cellUid);
    editBuffers.set(key, next);
    saveErrors.delete(key);
    setSaveState(next !== savedContent.get(key) ? 'dirty' : 'saved');
    setSaveError((e) => (e ? null : e));
    scheduleDraftFlush(key);
  }, [cellUid, pid]);

  // Discard the restored draft: revert the buffer to the disk baseline
  // recorded at settle() above, drop the persisted entry, and dismiss the
  // notice. Editing instead (without discarding) just dismisses the notice —
  // the restored content IS the buffer at that point, same as any other edit.
  const discardRestoredDraft = useCallback(() => {
    if (!cellUid) return;
    const key = bufKey(pid, cellUid);
    const baseline = savedContent.get(key) ?? '';
    cancelDraftFlush(key);
    clearPersistedDraft(key);
    editBuffers.set(key, baseline);
    saveErrors.delete(key);
    setValue(baseline);
    setSaveState('saved');
    setSaveError(null);
    setDraftRestoredFor(null);
  }, [cellUid, pid]);

  const doSave = useCallback(async () => {
    if (!cellUid || contentState !== 'ready') return;
    const key = bufKey(pid, cellUid);
    const html = editBuffers.get(key) ?? value;
    if (html === savedContent.get(key) && saveState !== 'error') return;
    setSaveState('saving');
    setSaveError(null);
    try {
      const client = await getMcpClient();
      if (hasRealCells) {
        await storyboardApi.write_cell_content(client, cellUid, html);
        await refetchStoryboard();
        await refreshRenders();
      } else {
        // standalone/mock: no real disk — round-trip through the override cache.
        setCellHtmlOverride(cellUid, html);
      }
      savedContent.set(key, html);
      savedAtMap.set(key, Date.now());
      saveErrors.delete(key);
      // The buffer may have moved on while the awaits were in flight — a
      // trailing unconditional 'saved' would clobber that dirtiness and the
      // newer keystrokes would read as persisted when they aren't.
      const current = editBuffers.get(key) ?? html;
      // A pending debounced flush was scheduled against the OLD baseline —
      // cancel it so it can't fire on stale data, then re-derive the draft
      // against the NEW baseline (`html`, now the disk truth): nothing left
      // to persist if no keystrokes landed during the await, otherwise the
      // keystrokes that did land are still an unsaved draft and must survive
      // a remount same as any other dirty buffer.
      cancelDraftFlush(key);
      if (current === html) clearPersistedDraft(key);
      else writePersistedDraft(key, current, html);
      // …and the SELECTION may have moved too. saveState belongs to whichever
      // cell is open now, so only the save for that cell may touch it; the
      // per-key maps above already carry the outcome for the cell we left.
      if (cellUidRef.current !== cellUid) return;
      setSaveState(current === html ? 'saved' : 'dirty');
    } catch (err) {
      const message = (err as Error).message;
      saveErrors.set(key, message);
      if (cellUidRef.current !== cellUid) return;
      setSaveState('error');
      setSaveError(message);
    }
  }, [cellUid, pid, value, contentState, saveState, hasRealCells, refetchStoryboard, refreshRenders]);

  // Cmd/Ctrl-S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        void doSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doSave]);

  // Crash-safe drafts: flush every dirty buffer this mount has touched (not
  // just the current cell — a cell switched away from earlier this mount can
  // still be dirty in the module Maps) to localStorage whenever the pane may
  // be about to disappear, and warn on an actual unload. A debounced flush
  // alone isn't enough here — the pane can vanish (shell remount, tab close)
  // between debounce ticks, which is exactly the crash the draft mirror
  // exists for. Mount-once: iterates module state directly, no cellUid dep.
  useEffect(() => {
    const flush = () => flushAllDrafts();
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      flush();
      if (anyDraftDirty()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);

  const dirty = saveState === 'dirty' || saveState === 'error';
  const canSave = dirty && contentState === 'ready';
  const savedAt = cellUid ? savedAtMap.get(bufKey(pid, cellUid)) : undefined;

  // ── anchors (shared store — review §2.4: was an independent anchor.list
  // per view; ensure() dedupes across Cell/Canvas/Handoff/Breakdown/Ledger/
  // CastWorld hydrating the same project) ──
  const storeAnchors = useAnchorsStore(selectAnchors);
  const ensureAnchors = useAnchorsStore((s) => s.ensure);
  const [anchorDrawerOpen, setAnchorDrawerOpen] = useState(false);
  useEffect(() => {
    if (hasRealCells && pid) ensureAnchors(pid);
  }, [hasRealCells, pid, ensureAnchors]);
  const anchors = hasRealCells ? storeAnchors : [];

  const drawerAnchors: Array<{ id: string; name: string; kind: string; color: CellColor }> = hasRealCells
    ? anchors.map((a) => ({ id: a.id, name: a.name, kind: a.kind, color: 'neutral' as CellColor }))
    : MOCK_ANCHORS.map((a) => ({ id: a.id, name: a.name, kind: a.kind, color: a.color }));

  const insertAnchorAtCursor = (anchorId?: string) => {
    const view = editorRef.current?.view();
    if (!view) return;
    insertAnchor(anchorId)(view);
    // the doc change flows through CodeEditor.onChange → onEditorChange (dirty).
  };

  // ── editor rail tab: source vs generate (CE-A editor kept intact; Generate
  // is an added tab, never a replacement) ──
  const [editorTab, setEditorTab] = useState<'source' | 'generate'>('source');

  // ── focus/review toggle: collapses the editor rail to a full-width
  // cinema-stage preview for keeper-picking ──
  const [focusMode, setFocusMode] = useState(false);

  // ── Generate tab: prompt / anchor refs / engine / seed ──
  const [genPrompt, setGenPrompt] = useState('');
  const [genSeed, setGenSeed] = useState<number>(() => randomSeed());
  const [genSeedLocked, setGenSeedLocked] = useState(false);
  const [genAnchorIds, setGenAnchorIds] = useState<string[]>([]);
  const [refPickerOpen, setRefPickerOpen] = useState(false);
  const [genEngine, setGenEngine] = useState<string>(HANDOFF_ENGINE_ID);
  // Which fal model the render resolves to — threaded as the render `variant`,
  // not a persisted Cell field (same as the Canvas per-shot picker). Starts on
  // Auto: an unchosen default must not reach the adapter as an override.
  const [genModel, setGenModel] = useState<string>(FAL_MODEL_AUTO);
  const [genPatchDirty, setGenPatchDirty] = useState(false);

  // Track-A candidates come from the shared shot-generate hook: engines that
  // report video, else whatever the server DOES report (never a fabricated fal
  // row). The capability matrix loads once in the hook, shared with Canvas.

  const engineDisplayName = useCallback((id: string): string => {
    if (id === HANDOFF_ENGINE_ID) return 'Higgsfield';
    return engineLabel(id);
  }, []);

  // Sync the Generate tab's local fields from the active cell whenever the
  // selection changes — real Cell.prompt/seed/anchors when present. A real
  // cell that has never been authored starts EMPTY (the fixture text is the
  // demo desk's alone); Generate stays disabled until the user writes one.
  useEffect(() => {
    if (!cellUid) return;
    setGenPrompt(hasRealCells ? rawCell?.prompt ?? '' : FIXTURE_PROMPT_SEED);
    setGenSeed(rawCell?.seed ?? randomSeed());
    setGenSeedLocked(rawCell?.seed != null);
    setGenAnchorIds(rawCell?.anchors ?? []);
    setGenPatchDirty(false);
    setRefPickerOpen(false);
  }, [cellUid, hasRealCells, rawCell?.prompt, rawCell?.seed, rawCell?.anchors]);

  // Default the engine pick once the capability matrix (or the cell's last
  // engine) is known.
  useEffect(() => {
    if (trackAEngines.length === 0) return;
    setGenEngine((cur) => (cur === HANDOFF_ENGINE_ID || trackAEngines.some((e) => e.id === cur)
      ? cur
      : trackAEngines[0].id));
  }, [trackAEngines]);

  const refAnchors = useMemo(
    () => drawerAnchors.filter((a) => genAnchorIds.includes(a.id)),
    [drawerAnchors, genAnchorIds],
  );
  const toggleGenAnchor = (id: string) => {
    setGenAnchorIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
    setGenPatchDirty(true);
  };

  // Persist prompt/seed/anchors to the Cell doc (real mode only — the Cell
  // schema carries these fields directly; mock/standalone has no disk to
  // write them to, so the fixture just holds the in-memory edit).
  //
  // `seed` is a parameter, not a read of genSeed: a caller that rolls a new
  // seed and persists in the same handler would otherwise write the value this
  // closure captured on the previous render — the render would run on the old
  // roll while the desk displayed the new one, which is exactly the
  // reproducibility the seed lock is supposed to guarantee.
  const persistGenPatch = useCallback(async (seed: number = genSeed) => {
    if (!hasRealCells || !cellUid) return;
    try {
      const client = await getMcpClient();
      await storyboardApi.write_cell(client, cellUid, {
        prompt: genPrompt,
        seed,
        anchors: genAnchorIds,
      });
      setGenPatchDirty(false);
      await refetchStoryboard();
    } catch {
      // keep the buffer + dirty flag — surfaced by the generate-button state
    }
  }, [hasRealCells, cellUid, genPrompt, genSeed, genAnchorIds, refetchStoryboard]);

  // A/B variants — every render record polled for this cell (real mode only;
  // mock/standalone has no render.list poll, so an honest empty tray).
  const variantsForCell: RenderRecord[] = useMemo(() => {
    if (!hasRealCells || !cellUid) return [];
    return renderRecords
      .filter((r) => r.cell_uid === cellUid)
      .slice()
      .sort((a, b) => {
        const ta = Date.parse(a.finished_at ?? a.started_at ?? '') || 0;
        const tb = Date.parse(b.finished_at ?? b.started_at ?? '') || 0;
        return tb - ta;
      });
  }, [hasRealCells, cellUid, renderRecords]);

  // Which variant is the "keeper" shown in the living preview. Defaults to
  // recordByUid's best-record pick; a click in the tray can override it
  // in-view (there is no dedicated server-side "keeper" field — this is a
  // local pick of which existing render to preview, not a fabricated one).
  const [keeperOverrideId, setKeeperOverrideId] = useState<string | null>(null);
  useEffect(() => { setKeeperOverrideId(null); }, [cellUid]);

  // ── draft preview: the editor buffer, settled ──
  // CodeMirror reports every keystroke; re-mounting a srcdoc pane that often
  // thrashes the pane and the parser. Trailing-edge only, so a pause paints.
  // A CELL SWITCH must never trail, though: the new cell's buffer resolves
  // synchronously, so a debounce carried across the switch would paint the
  // previous cell's html in the stage under this cell's label. The uid rides
  // with the html so the pane can only ever draw a draft it owns — a switch
  // reads as "nothing to draft yet" for a frame instead of misattributing.
  const [draft, setDraft] = useState<{ uid: string | null; html: string }>({ uid: null, html: '' });
  const draftUidRef = useRef<string | null>(null);
  useEffect(() => {
    if (valueUid !== cellUid) return;
    const commit = () => {
      draftUidRef.current = cellUid;
      setDraft({ uid: cellUid, html: value });
    };
    if (draftUidRef.current !== cellUid) { commit(); return; }
    const t = setTimeout(commit, DRAFT_PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [value, cellUid, valueUid]);

  const draftReady = contentState === 'ready' && valueUid === cellUid && draft.uid === cellUid;
  const draftHtml = draftReady ? draft.html : '';

  // null = follow the cell. The mp4 is the truth surface, so it leads wherever
  // one exists; the draft leads only on a cell that has nothing authoritative
  // to show yet (which is precisely where CE-A's living preview earns its
  // keep). An explicit pick always wins, and resets when the cell changes.
  const [previewModeOverride, setPreviewModeOverride] = useState<'rendered' | 'draft' | null>(null);
  useEffect(() => { setPreviewModeOverride(null); }, [cellUid]);

  // ── Higgsfield handoff (Track B — no API; prompt package + return leg) ──
  const [handoffPkg, setHandoffPkg] = useState<PromptPackage | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [handoffCopied, setHandoffCopied] = useState(false);
  const [ingestPath, setIngestPath] = useState('');
  const [ingestBusy, setIngestBusy] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);

  const runHandoffPackage = useCallback(async () => {
    if (!cellUid) return;
    setHandoffBusy(true);
    setHandoffError(null);
    try {
      await persistGenPatch();
      const pkg = await shot.packagePrompt(cellUid, { platform: 'higgsfield' });
      setHandoffPkg(pkg);
    } catch (err) {
      setHandoffError((err as Error).message);
    } finally {
      setHandoffBusy(false);
    }
  }, [cellUid, persistGenPatch, shot.packagePrompt]);

  const copyHandoffPrompt = useCallback(async () => {
    const entry = handoffPkg?.packages.find((p) => p.cellId === cellUid) ?? handoffPkg?.packages[0];
    if (!entry) return;
    const ok = await copyText(entry.prompt);
    if (ok) {
      setHandoffCopied(true);
      setTimeout(() => setHandoffCopied(false), 1500);
    }
  }, [handoffPkg, cellUid]);

  const runIngest = useCallback(async () => {
    if (!cellUid || !ingestPath.trim()) return;
    setIngestBusy(true);
    setIngestError(null);
    try {
      const rec = await shot.ingestExternal(cellUid, {
        filePath: ingestPath.trim(),
        engine: HANDOFF_ENGINE_ID,
      });
      setKeeperOverrideId(rec.id);
      setIngestPath('');
      await refetchStoryboard();
      await refreshRenders();
    } catch (err) {
      setIngestError((err as Error).message);
    } finally {
      setIngestBusy(false);
    }
  }, [cellUid, ingestPath, refetchStoryboard, refreshRenders, shot.ingestExternal]);

  // ── Approve / reject (storyboardApi.set_approved) ──
  const approve = useAsyncAction();
  const approveBusy = approve.busy;
  const approveError = approve.error;
  const cellApproved = hasRealCells ? rawCell?.approved ?? false : false;
  const runSetApproved = useCallback(async (approved: boolean) => {
    if (!cellUid || !hasRealCells) return;
    await approve.run(async (client) => {
      await storyboardApi.set_approved(client, cellUid, approved);
      await refetchStoryboard();
    });
  }, [cellUid, hasRealCells, refetchStoryboard, approve.run]);

  // ── render lifecycle + preview record (from the shared shot-generate hook) ──
  const renderState = shot.renderState;
  const renderProgress = shot.renderProgress;
  const triggerRender = shot.triggerRender;
  const lastRenderOpts = shot.lastRenderOpts;

  const recByUid = useMemo(
    () => (hasRealCells ? recordByUid(renderRecords) : {}),
    [hasRealCells, renderRecords],
  );
  const activeRecord = cellUid ? recByUid[cellUid] : undefined;
  // A/B variants tray click overrides which existing render is previewed.
  const keeperRecord = keeperOverrideId
    ? variantsForCell.find((r) => r.id === keeperOverrideId) ?? activeRecord
    : activeRecord;
  const activeRecordId = keeperRecord?.status === 'done' ? keeperRecord.id : null;
  const [videoState, setVideoState] = useState<CellVideoAvailability>('unavailable');
  // On a keeper/variant switch, reset to 'loading' (not 'unavailable') when a
  // record exists — the child's read_bytes fetch is in flight, not missing.
  // Resetting to 'unavailable' painted the alarming "Preview bytes
  // unavailable on this build" overlay for the whole fetch on every switch,
  // even on builds where bytes-over-bridge works fine.
  useEffect(() => { setVideoState(activeRecordId ? 'loading' : 'unavailable'); }, [activeRecordId]);

  const previewMode: 'rendered' | 'draft' = previewModeOverride ?? (activeRecordId ? 'rendered' : 'draft');

  // Both tracks write the prompt to the user's cell and then spend something on
  // it (a fal call, or the author's time on an external generator), so neither
  // may run on a prompt nobody wrote.
  const promptMissing = genPrompt.trim().length === 0;

  // One desk, one selection. Every render trigger in this view — the toolbar,
  // the empty stage, Generate — spends on the engine/model the Generate tab
  // has ON SCREEN, so no button can quietly bill a model the user isn't
  // looking at. The engine radio list is the server's full video-capable
  // matrix (hyperframes included), so this is a general render pick, not a
  // fal-only one. Higgsfield is the exception: it is a handoff, not a
  // renderer, and has no adapter to enqueue against — a render under it
  // carries no engine and the sidecar resolves one from the cell's
  // content_path, which is what the readouts below say it does.
  const renderOpts = useMemo<RenderOpts>(() => ({
    engine: genEngine === HANDOFF_ENGINE_ID ? undefined : genEngine,
    // Only fal reads a model variant; other adapters would choke on one.
    // Auto ('') must send nothing — see FAL_MODEL_AUTO.
    variant: genEngine === FAL_ENGINE_ID ? genModel || undefined : undefined,
  }), [genEngine, genModel]);

  // Names what a trigger will actually run on, so a button or a progress
  // readout can never imply an engine the enqueue didn't ask for.
  const describeRenderOpts = useCallback((o: RenderOpts): string => {
    if (!o.engine) return "engine resolved from this cell's content";
    return engineDisplayName(o.engine) + (o.variant ? ` · ${o.variant}` : '');
  }, [engineDisplayName]);

  // Generate = persist the prompt/seed/anchors + fire the render (Track A) or
  // package the prompt for an external generator (Track B / handoff).
  const runGenerate = useCallback(async () => {
    if (promptMissing) return;
    if (genEngine === HANDOFF_ENGINE_ID) {
      await runHandoffPackage();
      return;
    }
    // Decide the roll ONCE and hand it on explicitly. setGenSeed only schedules
    // an update — reading genSeed back out here (or letting persistGenPatch
    // read it) would persist and render the pre-click seed while the desk
    // showed the new one, so the seed on screen would not be the seed that made
    // the shot.
    const seed = genSeedLocked ? genSeed : randomSeed();
    setGenSeed(seed);
    await persistGenPatch(seed);
    await triggerRender(renderOpts);
  }, [promptMissing, genEngine, genSeedLocked, genSeed, renderOpts, persistGenPatch, triggerRender, runHandoffPackage]);

  const storeStatus: RenderStatus | undefined = cellUid ? renderStatus[cellUid] : undefined;
  const stripStatus = useCallback(
    (uid: string): RenderStatus | undefined => {
      if (hasRealCells) return renderStatus[uid];
      const m = MOCK_CELLS.find((c) => c.uid === uid);
      return m?.progress != null ? 'running' : undefined;
    },
    [hasRealCells, renderStatus],
  );

  const rendering =
    renderState === 'queued' || renderState === 'running' || storeStatus === 'queued' || storeStatus === 'running';
  const failed = renderState === 'failed' || storeStatus === 'failed';

  // What the running render is really on. Only the opts THIS view dispatched
  // may speak for a render it started; a render started elsewhere (Canvas, a
  // Chi) is named by the record the sidecar wrote. Naming a fixed engine here
  // reads as fact and was wrong for every render that wasn't HyperFrames.
  const inFlightLabel = lastRenderOpts
    ? describeRenderOpts(lastRenderOpts)
    : activeRecord?.engine
      ? engineDisplayName(activeRecord.engine) +
        (activeRecord.model_id ? ` · ${activeRecord.model_id}` : '')
      : "engine resolved from this cell's content";

  // ── narration (honest) ──
  // `narrationSync`/the playhead-driven highlight live in <NarrationRow> now
  // (review §2.6) — this view only derives the two inputs it needs.
  const narrationText = hasRealCells
    ? rawCell?.narration_excerpt ?? null
    : getNarrationExcerpt(cellUid)?.text ?? null;
  const narrationStaticIdx = hasRealCells ? 0 : getNarrationExcerpt(cellUid)?.activeWordIdx ?? 0;

  // ── header derived bits ──
  // The PROJECT's frame — which is all this is, and all the readout may say it
  // is. It is not this cell's: hyperframes lets the cell's own declared dims
  // beat it, and the frontend is never told the project's `resolution` override
  // at all, so any per-cell number sourced from here would be a guess wearing a
  // fact's clothes.
  const aspect: AspectRatio = project?.aspect_ratio ?? '16:9';
  const isPortrait = aspect === '9:16';
  // D-13: the same per-project overlay switch the Composition viewer toggles.
  const [safeZonesOn] = useRememberedToggle(pid ? `com.ikenga.studio:safe-zones:${pid}` : null, true);

  // The frame the DRAFT is laid out in. The draft draws this buffer, so the
  // buffer's own data-width/data-height is the authority — and it is the one the
  // renderer reads first, ahead of the project's aspect. Deriving from the
  // project alone lays a portrait cell out landscape and gets the one thing a
  // draft can be faithful about exactly backwards. A buffer that declares
  // nothing gets the project's aspect, the same fallback the renderer takes;
  // the disclosure then says which of the two it got, because "declared" and
  // "assumed" are different claims and only one of them is the cell's.
  const draftDeclaredAspect = useMemo(
    () => (draftReady ? declaredAspect(draftHtml) : undefined),
    [draftReady, draftHtml],
  );
  const draftAspect: AspectRatio = draftDeclaredAspect ?? aspect;
  const contentPath = cell
    ? (rawCell?.content_path ?? `cells/${RUNG_DIR[cell.rung]}/${cell.uid}/content.html`)
    : '';
  const rungsForBeat = useMemo(() => {
    if (!cell) return new Set<Rung>();
    return new Set(stripCells.filter((c) => c.beat === cell.beat).map((c) => c.rung));
  }, [stripCells, cell]);

  // ── empty project (no cells at all) ──
  if (stripCells.length === 0) {
    return (
      <EmptyState glyph="▤" title="No cells yet" hint="the storyboard is written for you, not by hand">
        <p className="mt-1 max-w-xs text-[11px] leading-relaxed text-fg-faint">
          Ask your Chi in the chat dock to storyboard this project — try{' '}
          <span className="font-mono text-fg-muted">"storyboard a 30s explainer"</span>. It writes the
          cells straight into the canvas.
        </p>
      </EmptyState>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-base text-fg">
      {/* ═══ persistent cell strip (CE-C graft — no dead ends) ═══ */}
      <div
        role="tablist"
        aria-label="Cells in this project"
        className="flex items-stretch gap-2 overflow-x-auto border-b border-soft bg-sunken px-3 py-2"
      >
        {stripCells.map((c) => {
          const st = stripStatus(c.uid);
          const active = c.uid === cellUid;
          return (
            <button
              type="button"
              key={c.uid}
              role="tab"
              aria-selected={active}
              aria-label={
                `${c.beat} cell, ${c.uid}, ${RUNG_LABEL[c.rung]} rung` +
                (c.duration_ms ? `, ${fmtSeconds(c.duration_ms)} long` : '')
              }
              onClick={() => setCellUid(c.uid)}
              title={
                `${c.uid} · ${c.duration_ms ? `${fmtSeconds(c.duration_ms)} · ` : ''}` +
                `${c.beat} · ${RUNG_LABEL[c.rung]}`
              }
              className="flex min-w-[172px] flex-1 items-center gap-2.5 rounded-md border p-1.5 text-left transition-colors"
              style={{
                borderColor: active ? `var(${COLOR_VAR[c.color]})` : 'var(--border-soft)',
                background: active ? roleTint(c.color, 9) : 'var(--bg-surface)',
                boxShadow: active ? `inset 0 0 0 1px ${roleTint(c.color, 30)}` : undefined,
              }}
            >
              <span
                className="flex h-[38px] w-[64px] flex-none items-center justify-center overflow-hidden rounded-sm text-[8px]"
                style={{
                  background: `linear-gradient(160deg, ${roleTint(c.color, 22)}, var(--bg-sunken))`,
                  border: `1px solid ${roleTint(c.color, 26)}`,
                }}
              >
                <span className="font-mono uppercase tracking-wider" style={{ color: `var(${COLOR_VAR[c.color]})` }}>
                  {RUNG_LABEL[c.rung].slice(0, 4)}
                </span>
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-mono text-[11px] text-fg">{c.uid}</span>
                <span className="flex items-center gap-1.5 font-mono text-[10px] text-fg-muted">
                  <StatusDot status={st} />
                  {c.duration_ms ? (
                    <span className="flex-none text-fg-faint">{fmtSeconds(c.duration_ms)} ·</span>
                  ) : null}
                  <span className="truncate" style={{ color: `var(${COLOR_VAR[c.color]})` }}>{c.beat}</span>
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {/* no cell selected → inline prompt (strip stays put; not a dead end) */}
      {!cell ? (
        <div className="grid min-h-0 flex-1 place-items-center bg-sunken p-8 text-center">
          <div className="max-w-sm">
            <div
              aria-hidden="true"
              className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-soft bg-raised text-fg-faint"
            >
              ▤
            </div>
            <div className="font-display text-sm text-fg-muted">Pick a cell to edit</div>
            <p className="mt-1 text-[11px] leading-relaxed text-fg-faint">
              Choose any cell in the strip above — you never have to leave this view to switch.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* ═══ header: cell chip · rung ladder · save cluster · render ═══ */}
          <div className="flex items-center gap-3 border-b border-soft bg-sunken px-3 py-1.5 text-[11px]">
            <div className="flex min-w-0 items-center gap-2 text-fg-muted">
              <span className="font-mono">{contentPath}</span>
              <span
                className="rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ring-1 ring-inset"
                style={{
                  color: `var(${COLOR_VAR[cell.color]})`,
                  background: roleTint(cell.color, 15),
                  borderColor: roleTint(cell.color, 40),
                }}
              >
                {cell.beat}
              </span>
            </div>

            {/* rung ladder — beat sheet → lo-fi → hi-fi (current cell's rung) */}
            <nav className="flex items-center gap-1" aria-label="Fidelity rung">
              {RUNG_ORDER.map((r) => {
                const isCurrent = r === cell.rung;
                const isDone = !isCurrent && rungsForBeat.has(r);
                return (
                  <span
                    key={r}
                    aria-current={isCurrent ? 'step' : undefined}
                    className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider"
                    style={{ color: isCurrent ? 'var(--achievement)' : isDone ? 'var(--fg-muted)' : 'var(--fg-faint)' }}
                  >
                    <span
                      className="h-[7px] w-[7px] rounded-full border"
                      style={{
                        background: isCurrent ? 'var(--achievement)' : isDone ? 'var(--live)' : 'transparent',
                        borderColor: isCurrent ? 'var(--achievement)' : isDone ? 'var(--live)' : 'var(--fg-faint)',
                        boxShadow: isCurrent ? '0 0 0 3px var(--achievement-soft)' : undefined,
                      }}
                    />
                    {RUNG_SHORT[r]}
                  </span>
                );
              })}
            </nav>

            <div className="flex-1" />

            {/* save cluster */}
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5" role="status" aria-live="polite">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{
                    background:
                      saveState === 'error'
                        ? 'var(--danger)'
                        : saveState === 'dirty'
                        ? 'var(--achievement)'
                        : saveState === 'saving'
                        ? 'transparent'
                        : 'var(--live)',
                    boxShadow:
                      saveState === 'error'
                        ? '0 0 0 3px var(--danger-soft)'
                        : saveState === 'dirty'
                        ? '0 0 0 3px var(--achievement-soft)'
                        : saveState === 'saved'
                        ? '0 0 0 3px var(--live-soft)'
                        : undefined,
                  }}
                />
                <span className="text-fg-muted">
                  {saveState === 'saved' && 'Saved'}
                  {saveState === 'dirty' && 'Unsaved changes'}
                  {saveState === 'saving' && 'Saving…'}
                  {saveState === 'error' && 'Save failed'}
                </span>
                {saveState === 'saved' && savedAt && (
                  <span className="font-mono text-[10px] text-fg-faint">{fmtHHMM(savedAt)}</span>
                )}
              </span>
              <button
                type="button"
                onClick={() => void doSave()}
                disabled={!canSave}
                className={
                  'flex items-center gap-1.5 rounded px-2 py-1 ring-1 ring-inset ' +
                  (canSave
                    ? 'bg-raised text-fg ring-[var(--border)] hover:bg-[color-mix(in_oklab,var(--bg-raised)_70%,var(--fg)_6%)]'
                    : 'cursor-not-allowed text-fg-faint ring-[var(--border-soft)] opacity-50')
                }
              >
                ⌘S Save
              </button>
              <button
                type="button"
                onClick={() => void triggerRender(renderOpts)}
                disabled={renderState === 'queued' || renderState === 'running'}
                title={`Render this cell — ${describeRenderOpts(renderOpts)}`}
                className={
                  'flex items-center gap-1.5 rounded px-2 py-1 ring-1 ring-inset ' +
                  (renderState === 'idle' || renderState === 'done'
                    ? 'bg-[color-mix(in_oklab,var(--primary)_60%,transparent)] text-[var(--primary-fg)] ring-[color-mix(in_oklab,var(--primary)_50%,transparent)] hover:bg-[color-mix(in_oklab,var(--primary)_78%,transparent)]'
                    : renderState === 'failed'
                    ? 'bg-[color-mix(in_oklab,var(--danger)_18%,transparent)] text-[var(--danger)] ring-[color-mix(in_oklab,var(--danger)_40%,transparent)]'
                    : 'cursor-wait bg-raised text-fg-muted ring-[var(--border)]')
                }
              >
                {(renderState === 'idle') && <span>▶ Render cell</span>}
                {renderState === 'queued' && <span>● Queued…</span>}
                {renderState === 'running' && <span>● Rendering…</span>}
                {renderState === 'done' && <span>↻ Re-render</span>}
                {renderState === 'failed' && <span>! Retry render</span>}
              </button>

              {/* approve / reject (storyboardApi.set_approved) — honest no-op in mock */}
              <div className="flex items-center gap-1" role="group" aria-label="Approve or reject this cell">
                <button
                  type="button"
                  onClick={() => void runSetApproved(true)}
                  disabled={!hasRealCells || approveBusy || cellApproved}
                  aria-pressed={cellApproved}
                  title={hasRealCells ? 'Approve this cell' : 'Approve is disabled in standalone/mock mode'}
                  className={
                    'flex items-center gap-1.5 rounded px-2 py-1 ring-1 ring-inset disabled:cursor-not-allowed disabled:opacity-50 ' +
                    (cellApproved
                      ? 'ring-[color-mix(in_oklab,var(--live)_45%,transparent)]'
                      : 'bg-raised text-fg-muted ring-[var(--border)] hover:text-fg')
                  }
                  style={cellApproved ? { color: 'var(--live)', background: 'var(--live-soft)' } : undefined}
                >
                  ✓ {cellApproved ? 'Approved' : 'Approve'}
                </button>
                <button
                  type="button"
                  onClick={() => void runSetApproved(false)}
                  disabled={!hasRealCells || approveBusy || !cellApproved}
                  title={hasRealCells ? 'Reject / unapprove this cell' : 'Reject is disabled in standalone/mock mode'}
                  className="flex items-center gap-1.5 rounded px-2 py-1 text-fg-muted ring-1 ring-inset ring-[var(--border)] hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                >
                  ✕ Reject
                </button>
              </div>

              {/* focus/review toggle — collapses the editor rail to a full-width stage */}
              <button
                type="button"
                onClick={() => setFocusMode((f) => !f)}
                aria-pressed={focusMode}
                title={focusMode ? 'Back to the split editor' : 'Focus: full-width preview for keeper-picking'}
                className={
                  'flex items-center gap-1.5 rounded px-2 py-1 ring-1 ring-inset ' +
                  (focusMode ? 'bg-raised text-fg ring-[var(--border)]' : 'text-fg-muted ring-[var(--border-soft)] hover:text-fg')
                }
              >
                {focusMode ? '‹ Editor' : '⛶ Focus'}
              </button>
            </div>
          </div>

          {approveError && (
            <div
              role="alert"
              className="border-b px-3 py-1.5 text-[11px]"
              style={{
                background: 'var(--danger-soft)',
                borderColor: 'color-mix(in oklab, var(--danger) 40%, var(--border))',
                color: 'color-mix(in oklab, var(--danger) 55%, var(--fg))',
              }}
            >
              Couldn't update approval — {approveError}
            </div>
          )}

          {/* unsaved-draft-restored notice (crash-safe drafts — a dirty edit a
              prior mount could only reach localStorage, not disk) */}
          {draftRestoredFor === cellUid && (
            <div
              role="status"
              className="flex items-center gap-2 border-b px-3 py-1.5 text-[11px]"
              style={{
                background: 'var(--info-soft)',
                borderColor: 'color-mix(in oklab, var(--info) 40%, var(--border))',
                color: 'color-mix(in oklab, var(--info) 55%, var(--fg))',
              }}
            >
              <span className="flex-1">
                Unsaved draft restored from an earlier session. Save to keep it, or discard to go back to what's on disk.
              </span>
              <button
                type="button"
                onClick={discardRestoredDraft}
                className="underline"
                style={{ color: 'var(--info)' }}
              >
                Discard
              </button>
              <button
                type="button"
                onClick={() => setDraftRestoredFor(null)}
                className="text-fg-faint hover:text-fg"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* error banner (save failure — keeps the buffer, offers retry) */}
          {saveState === 'error' && (
            <div
              role="alert"
              className="flex items-center gap-2 border-b px-3 py-1.5 text-[11px]"
              style={{
                background: 'var(--danger-soft)',
                borderColor: 'color-mix(in oklab, var(--danger) 40%, var(--border))',
                color: 'color-mix(in oklab, var(--danger) 55%, var(--fg))',
              }}
            >
              <span className="flex-1">
                Couldn't save this cell{saveError ? ` — ${saveError}` : '.'} Your edits are kept.
              </span>
              <button
                type="button"
                onClick={() => void doSave()}
                className="underline"
                style={{ color: 'var(--danger)' }}
              >
                Retry
              </button>
            </div>
          )}

          {/* content-unavailable banner (server build lacks the read seam) */}
          {contentState === 'unavailable' && (
            <div
              role="status"
              className="border-b border-soft bg-base px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-fg-faint"
            >
              couldn't load this cell's source — the studio server on this build doesn't expose cell content
            </div>
          )}

          {/* anchor drawer */}
          {anchorDrawerOpen && (
            <div className="border-b border-soft bg-surface px-4 py-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">
                  project anchors · click to insert at cursor
                </div>
                <button
                  type="button"
                  onClick={() => setAnchorDrawerOpen(false)}
                  className="text-[11px] text-fg-faint hover:text-fg"
                >
                  close
                </button>
              </div>
              {drawerAnchors.length === 0 ? (
                <div className="text-[11px] text-fg-muted">
                  No anchors in this project yet — ask your Chi to import brand assets, or add one below.
                </div>
              ) : (
                <div className="grid grid-cols-5 gap-2">
                  {drawerAnchors.map((a) => (
                    <button
                      type="button"
                      key={a.id}
                      onClick={() => insertAnchorAtCursor(a.id)}
                      className="rounded border border-[var(--border)] bg-base p-2 text-left hover:border-[var(--border-soft)] hover:bg-raised"
                      title={`Insert <img data-anchor="${a.id}"> at cursor`}
                    >
                      <div className="mb-1 flex items-center gap-1.5">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ background: `var(${COLOR_VAR[a.color]})` }}
                        />
                        <span className="font-mono text-[10px] text-fg">{a.id}</span>
                      </div>
                      <div className="truncate text-[10px] text-fg">{a.name}</div>
                      <div className="font-mono text-[9px] text-fg-faint">{a.kind}</div>
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => insertAnchorAtCursor()}
                    title="Insert a new auto-numbered anchor at cursor"
                    className="flex items-center justify-center rounded border border-dashed border-[var(--border)] bg-base p-2 text-[11px] text-fg-faint hover:border-[var(--border-soft)] hover:text-fg"
                  >
                    + new
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ═══ split: editor rail (Source | Generate) | living preview ═══
                Focus mode collapses the rail entirely for full-width keeper-picking. */}
          <div className="flex min-h-0 flex-1">
            {/* editor rail */}
            {!focusMode && (
              <div className="flex min-h-0 flex-1 flex-col border-r border-soft bg-sunken">
                <div className="flex items-center gap-1 border-b border-soft bg-surface px-2 pt-1.5 text-[11px] text-fg-muted">
                  <button
                    type="button"
                    onClick={() => setEditorTab('source')}
                    aria-pressed={editorTab === 'source'}
                    className={
                      'rounded-t px-2.5 py-1 ' +
                      (editorTab === 'source' ? 'bg-sunken text-fg' : 'text-fg-muted hover:text-fg')
                    }
                  >
                    Source
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditorTab('generate')}
                    aria-pressed={editorTab === 'generate'}
                    className={
                      'rounded-t px-2.5 py-1 ' +
                      (editorTab === 'generate' ? 'bg-sunken' : 'text-fg-muted hover:text-fg')
                    }
                    style={editorTab === 'generate' ? { color: 'var(--agent)' } : undefined}
                  >
                    ✦ Generate
                  </button>
                  <div className="flex-1" />
                  {editorTab === 'source' && (
                    <>
                      <span className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">{contentPath.split('/').pop() ?? 'content.html'}</span>
                      <button
                        type="button"
                        onClick={() => setAnchorDrawerOpen((o) => !o)}
                        aria-expanded={anchorDrawerOpen}
                        className={
                          'ml-2 flex items-center gap-1.5 rounded px-2 py-0.5 mb-1 ' +
                          (anchorDrawerOpen ? 'bg-raised text-fg' : 'text-fg-muted hover:bg-raised hover:text-fg')
                        }
                      >
                        <span>✦ Anchors</span>
                        <span className="font-mono text-[10px] text-fg-faint">{drawerAnchors.length}</span>
                      </button>
                    </>
                  )}
                </div>

                {editorTab === 'source' ? (
                  <div className="relative min-h-0 flex-1">
                    <CodeEditor
                      ref={editorRef}
                      value={value}
                      onChange={onEditorChange}
                      readOnly={contentState !== 'ready'}
                      language="html"
                      ariaLabel={`Cell ${cell.uid} HTML editor`}
                      className="h-full min-h-0"
                    />
                    {contentState === 'loading' && (
                      <div
                        className="absolute inset-0 grid place-items-center font-mono text-[10px] uppercase tracking-wider text-fg-faint"
                        style={{ background: 'color-mix(in oklab, var(--bg-sunken) 70%, transparent)' }}
                      >
                        loading source…
                      </div>
                    )}
                  </div>
                ) : (
                  <GenerateTab
                    genPrompt={genPrompt}
                    setGenPrompt={(v) => { setGenPrompt(v); setGenPatchDirty(true); }}
                    refAnchors={refAnchors}
                    drawerAnchors={drawerAnchors}
                    genAnchorIds={genAnchorIds}
                    toggleGenAnchor={toggleGenAnchor}
                    refPickerOpen={refPickerOpen}
                    setRefPickerOpen={setRefPickerOpen}
                    trackAEngines={trackAEngines}
                    genEngine={genEngine}
                    setGenEngine={setGenEngine}
                    engineDisplayName={engineDisplayName}
                    genSeed={genSeed}
                    setGenSeed={setGenSeed}
                    genSeedLocked={genSeedLocked}
                    setGenSeedLocked={setGenSeedLocked}
                    isFal={genEngine === FAL_ENGINE_ID}
                    genModel={genModel}
                    setGenModel={setGenModel}
                    onGenerate={() => void runGenerate()}
                    generating={rendering || handoffBusy}
                    promptMissing={promptMissing}
                    isHandoff={genEngine === HANDOFF_ENGINE_ID}
                    handoffPkg={handoffPkg}
                    handoffError={handoffError}
                    handoffCopied={handoffCopied}
                    onCopyHandoffPrompt={() => void copyHandoffPrompt()}
                    ingestPath={ingestPath}
                    setIngestPath={setIngestPath}
                    ingestBusy={ingestBusy}
                    ingestError={ingestError}
                    onIngest={() => void runIngest()}
                    hasRealCells={hasRealCells}
                    genPatchDirty={genPatchDirty}
                    COLOR_VAR={COLOR_VAR}
                  />
                )}
              </div>
            )}

            {/* living preview — the REAL rendered cell */}
            <div className={'flex min-h-0 flex-col bg-base ' + (focusMode ? 'w-full' : 'w-[46%]')}>
              <div className="flex items-center gap-2 border-b border-soft bg-surface px-3 py-1.5 text-[11px] text-fg-muted">
                <span>Preview</span>
                {/* Named as the PROJECT's frame, because that is the only one
                    of the two this is. A cell can declare its own and win — the
                    draft's disclosure carries that number, sourced from the
                    buffer that actually declares it. */}
                <span className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">
                  Project {aspect} · {aspectRes(aspect)}
                </span>
                {/* Rendered vs Draft is a truth distinction, not a display
                    option — both are always named so it is never ambiguous
                    which surface is on screen. */}
                <div
                  role="group"
                  aria-label="Preview source"
                  className="ml-1 flex items-center gap-0.5 rounded bg-raised p-0.5"
                >
                  {(['rendered', 'draft'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setPreviewModeOverride(m)}
                      aria-pressed={previewMode === m}
                      title={
                        m === 'rendered'
                          ? 'The rendered mp4 — the authoritative frame'
                          : "Your editor source, drawn approximately — only what the buffer carries inline, so no fonts, stylesheets, images, or scripts"
                      }
                      className={
                        'rounded px-2 py-0.5 text-[10.5px] ' +
                        (previewMode === m ? 'bg-surface text-fg' : 'text-fg-faint hover:text-fg-muted')
                      }
                    >
                      {m === 'rendered' ? 'Rendered' : 'Draft'}
                    </button>
                  ))}
                </div>
                <div className="flex-1" />
                {previewMode === 'draft' ? (
                  <span className="inline-flex items-center gap-1.5 text-fg-faint">
                    <span
                      className="h-[7px] w-[7px] rounded-full border"
                      style={{ borderColor: 'var(--fg-faint)' }}
                    />
                    <span>Approximation — not the rendered frame</span>
                  </span>
                ) : activeRecordId && videoState === 'ready' ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-[7px] w-[7px] rounded-full" style={{ background: 'var(--live)', boxShadow: '0 0 0 3px var(--live-soft)' }} />
                    <span>Rendered</span>
                    <span className="font-mono text-[10px] text-fg-faint">
                      {fmtRelative(activeRecord?.finished_at, Date.now())}
                    </span>
                  </span>
                ) : rendering ? (
                  <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--ember)' }}>
                    <span className="h-[7px] w-[7px] rounded-full" style={{ background: 'var(--ember)' }} />
                    <span>Rendering</span>
                  </span>
                ) : null}
              </div>

              <div className="grid min-h-0 flex-1 place-items-center p-3">
                <div
                  className="relative flex items-center justify-center overflow-hidden rounded-sm bg-sunken"
                  style={previewFrameStyle(aspect)}
                >
                  {previewMode === 'draft' && (
                    <DraftPreview html={draftHtml} ready={draftReady} aspect={draftAspect} />
                  )}

                  {/* real rendered mp4 */}
                  {previewMode === 'rendered' && activeRecordId && (
                    <RenderedCellVideo recordId={activeRecordId} onState={setVideoState} />
                  )}

                  {/* honest overlays for every non-playing state */}
                  {previewMode === 'rendered' &&
                    (!activeRecordId || videoState === 'unavailable' || videoState === 'error') && (
                    <div className="grid place-items-center px-4 text-center">
                      {rendering ? (
                        <div className="grid gap-3 justify-items-center">
                          <div
                            className="h-8 w-8 animate-spin rounded-full border-[3px] border-[var(--border)]"
                            style={{ borderTopColor: 'var(--ember)' }}
                          />
                          <div className="text-[13px] text-fg">Rendering this cell…</div>
                          {/* honest indeterminate bar — no fabricated percentage */}
                          <div className="relative h-1 w-48 overflow-hidden rounded-full bg-raised">
                            <div className="studio-indet rounded-full" />
                          </div>
                          <div className="font-mono text-[10px] text-fg-muted">{inFlightLabel}</div>
                        </div>
                      ) : failed ? (
                        <div className="grid gap-2 justify-items-center">
                          <div className="text-2xl" style={{ color: 'var(--danger)' }}>!</div>
                          <div className="text-[13px] text-fg-muted">Render failed</div>
                          <button
                            type="button"
                            onClick={() => void triggerRender(lastRenderOpts ?? renderOpts)}
                            title={`Retry — ${describeRenderOpts(lastRenderOpts ?? renderOpts)}`}
                            className="rounded px-2 py-1 text-[11px] ring-1 ring-inset ring-[var(--border)] text-fg hover:bg-raised"
                          >
                            ↻ Try again
                          </button>
                        </div>
                      ) : videoState === 'unavailable' && activeRecordId ? (
                        <div className="grid gap-2 justify-items-center">
                          <div className="text-[13px] text-fg-muted">Preview bytes unavailable on this build</div>
                          <div className="font-mono text-[10px] text-fg-faint">
                            render exists — bytes-over-bridge not served here
                          </div>
                        </div>
                      ) : (
                        <div className="grid gap-3 justify-items-center">
                          <div
                            aria-hidden="true"
                            className="flex h-11 w-11 items-center justify-center rounded-lg border border-soft bg-raised text-fg-faint"
                          >
                            ▷
                          </div>
                          <div className="text-[13px] text-fg-muted">Not rendered yet</div>
                          <button
                            type="button"
                            onClick={() => void triggerRender(renderOpts)}
                            title={`Render this cell — ${describeRenderOpts(renderOpts)}`}
                            className="rounded px-3 py-1 text-[11px] ring-1 ring-inset"
                            style={{
                              background: 'color-mix(in oklab, var(--primary) 60%, transparent)',
                              color: 'var(--primary-fg)',
                              borderColor: 'transparent',
                            }}
                          >
                            ▶ Render this cell
                          </button>
                          {!hasRealCells && (
                            <div className="max-w-[16rem] font-mono text-[9px] leading-relaxed text-fg-faint">
                              standalone preview · the rendered mp4 appears here once a render backend is attached
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Last in the stage on purpose: the bands mark the frame's
                      safe zone, so they must sit over whatever is previewing.
                      With no z-index of their own they rely on paint order,
                      and the draft's iframe host is positioned too. */}
                  {isPortrait && safeZonesOn && <SafeZones />}
                </div>
              </div>

              {/* Says in prose what the draft is and is not — a badge alone
                  leaves the reader to infer how far to trust the pane, and
                  points at the mp4 whenever a real one exists to compare. */}
              {previewMode === 'draft' && draftReady && (
                <div className="border-t border-soft bg-surface px-3 py-1.5 text-[10px] leading-relaxed text-fg-faint">
                  Draft of your editor source, laid out at {aspectRes(draftAspect)}
                  {draftDeclaredAspect
                    ? ` — the ${draftAspect} frame this cell's HTML declares — `
                    : ` — this project's ${aspect} frame, as the HTML declares none — `}
                  and scaled to fit. Only what the buffer carries inline is drawn: no fonts,
                  stylesheets, images, or scripts load here, so it approximates the first frame
                  rather than reproducing it.{' '}
                  {activeRecordId ? (
                    <button
                      type="button"
                      onClick={() => setPreviewModeOverride('rendered')}
                      className="underline hover:text-fg-muted"
                    >
                      A rendered mp4 exists for this cell — show it
                    </button>
                  ) : (
                    <span>This cell has not been rendered yet.</span>
                  )}
                </div>
              )}

              {/* ═══ A/B variants tray — every polled render for this cell, pick the keeper ═══ */}
              <div className="border-t border-soft bg-surface">
                <div className="flex items-center gap-2 px-3 pt-2 text-[11px] text-fg-muted">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">Variants</span>
                  <span className="font-mono text-[10px] text-fg-faint">
                    {hasRealCells
                      ? `${variantsForCell.length} render${variantsForCell.length === 1 ? '' : 's'}`
                      : 'unavailable in standalone/mock mode'}
                  </span>
                  <div className="flex-1" />
                  {variantsForCell.length > 0 && <span className="font-mono text-[10px] text-fg-faint">click to pick the keeper</span>}
                </div>
                {!hasRealCells ? (
                  <div className="px-3 py-3 text-[11px] text-fg-faint">
                    Variants need a real render backend — generate on a real project to see them here.
                  </div>
                ) : variantsForCell.length === 0 ? (
                  <div className="px-3 py-3 text-[11px] text-fg-muted">
                    No renders yet — Generate above to create the first variant.
                  </div>
                ) : (
                  <div className="flex gap-2 overflow-x-auto px-3 py-2.5">
                    {variantsForCell.map((r, i) => {
                      const isKeeper = r.id === activeRecordId;
                      const seed = typeof r.metadata?.seed === 'number' ? r.metadata.seed : undefined;
                      const cost = r.cost_actual ?? r.cost_estimate;
                      return (
                        <button
                          type="button"
                          key={r.id}
                          onClick={() => setKeeperOverrideId(r.id)}
                          title={`seed ${seed ?? '—'} · ${r.status}`}
                          className="relative w-[132px] flex-none rounded-md border p-1.5 text-left"
                          style={{
                            borderColor: isKeeper ? 'var(--achievement)' : 'var(--border)',
                            background: 'var(--bg-raised)',
                            boxShadow: isKeeper ? 'inset 0 0 0 1px var(--achievement)' : undefined,
                          }}
                        >
                          {isKeeper && (
                            <span
                              className="absolute left-1.5 top-1.5 z-10 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider"
                              style={{ background: 'var(--achievement)', color: 'var(--bg-sunken)' }}
                            >
                              Keeper
                            </span>
                          )}
                          <div
                            className="relative flex aspect-video items-center justify-center overflow-hidden rounded"
                            style={{ background: 'var(--bg-sunken)' }}
                          >
                            {r.status === 'running' || r.status === 'queued' ? (
                              <span
                                className="h-5 w-5 animate-spin rounded-full border-2"
                                style={{ borderColor: 'var(--border)', borderTopColor: 'var(--agent)' }}
                              />
                            ) : r.status === 'failed' ? (
                              <span style={{ color: 'var(--danger)' }}>!</span>
                            ) : (
                              <span className="text-fg-faint">▷</span>
                            )}
                          </div>
                          <div className="mt-1 grid gap-0.5">
                            <span className="font-mono text-[10px] text-fg-muted">seed {seed ?? '—'}</span>
                            <span className="font-mono text-[9px] text-fg-faint">
                              {cost != null ? `$${cost.toFixed(2)} · ` : ''}v{variantsForCell.length - i}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => void runGenerate()}
                      disabled={promptMissing}
                      title={
                        promptMissing
                          ? 'Write a prompt in the Generate tab first'
                          : 'Generate another variant'
                      }
                      className="flex aspect-video w-[132px] flex-none items-center justify-center rounded-md border border-dashed text-fg-faint hover:text-fg-muted disabled:cursor-not-allowed disabled:opacity-40"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      +
                    </button>
                  </div>
                )}
              </div>

              {/* narration row (honest) — playhead subscription lives inside */}
              <NarrationRow narrationText={narrationText} narrationStaticIdx={narrationStaticIdx} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── small helpers ────────────────────────────────────────────────────────

function StatusDot({ status }: { status: RenderStatus | undefined }) {
  if (status === 'done') {
    return <span className="h-[6px] w-[6px] rounded-full" style={{ background: 'var(--live)', boxShadow: '0 0 0 2px var(--live-soft)' }} />;
  }
  if (status === 'running' || status === 'queued') {
    return <span className="h-[6px] w-[6px] rounded-full" style={{ background: 'var(--ember)' }} />;
  }
  if (status === 'failed') {
    return <span className="h-[6px] w-[6px] rounded-full" style={{ background: 'var(--danger)' }} />;
  }
  return <span className="h-[6px] w-[6px] rounded-full" style={{ background: 'var(--fg-faint)' }} />;
}

/** Cell duration as the locked strip renders it (CE-C's "{dur}s · beat"). */
function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtHHMM(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ─── Generate tab (production-desk graft) ────────────────────────────────
//
// Editable prompt + anchor refs + engine/seed + the Generate CTA. Track A
// (a real engine reporting `.video`) fires compositionApi.render with that
// engine id; Track B (Higgsfield — no API) packages the prompt via
// export.prompt_package and offers a small "attach the returned clip" form
// wired to render.ingest_external. Purely additive to the CE-A editor rail —
// it lives behind its own tab, never displacing Source.

type DrawerAnchor = { id: string; name: string; kind: string; color: CellColor };

function GenerateTab(props: {
  genPrompt: string;
  setGenPrompt: (v: string) => void;
  refAnchors: DrawerAnchor[];
  drawerAnchors: DrawerAnchor[];
  genAnchorIds: string[];
  toggleGenAnchor: (id: string) => void;
  refPickerOpen: boolean;
  setRefPickerOpen: (v: boolean | ((o: boolean) => boolean)) => void;
  trackAEngines: EngineCapability[];
  genEngine: string;
  setGenEngine: (id: string) => void;
  engineDisplayName: (id: string) => string;
  genSeed: number;
  setGenSeed: (n: number) => void;
  genSeedLocked: boolean;
  setGenSeedLocked: (v: boolean | ((o: boolean) => boolean)) => void;
  isFal: boolean;
  genModel: string;
  setGenModel: (m: string) => void;
  onGenerate: () => void;
  generating: boolean;
  promptMissing: boolean;
  isHandoff: boolean;
  handoffPkg: PromptPackage | null;
  handoffError: string | null;
  handoffCopied: boolean;
  onCopyHandoffPrompt: () => void;
  ingestPath: string;
  setIngestPath: (v: string) => void;
  ingestBusy: boolean;
  ingestError: string | null;
  onIngest: () => void;
  hasRealCells: boolean;
  genPatchDirty: boolean;
  COLOR_VAR: Record<CellColor, string>;
}) {
  const {
    genPrompt, setGenPrompt, refAnchors, drawerAnchors, genAnchorIds, toggleGenAnchor,
    refPickerOpen, setRefPickerOpen, trackAEngines, genEngine, setGenEngine, engineDisplayName,
    genSeed, setGenSeed, genSeedLocked, setGenSeedLocked, isFal, genModel, setGenModel,
    onGenerate, generating, promptMissing, isHandoff,
    handoffPkg, handoffError, handoffCopied, onCopyHandoffPrompt, ingestPath, setIngestPath,
    ingestBusy, ingestError, onIngest, hasRealCells, genPatchDirty, COLOR_VAR,
  } = props;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="grid gap-4">

        {/* prompt */}
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-fg-faint">
            <span>Prompt</span>
            <span className="normal-case tracking-normal text-fg-faint">editable{genPatchDirty ? ' · unsaved' : ''}</span>
          </div>
          <textarea
            value={genPrompt}
            onChange={(e) => setGenPrompt(e.target.value)}
            spellCheck={false}
            rows={5}
            className="w-full resize-y rounded-lg border border-[var(--border)] bg-raised px-3 py-2.5 text-[13px] leading-relaxed text-fg outline-none focus:border-[var(--agent)]"
            style={{ boxShadow: 'none' }}
            aria-label="Shot generation prompt"
          />
        </div>

        {/* anchor refs */}
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-fg-faint">
            <span>Anchor references</span>
            <span className="normal-case tracking-normal text-fg-faint">seed-locked cast &amp; world</span>
          </div>
          <div className="relative flex flex-wrap gap-2">
            {refAnchors.length === 0 && (
              <span className="text-[11px] text-fg-faint">No anchors referenced yet.</span>
            )}
            {refAnchors.map((a) => (
              <span
                key={a.id}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-raised py-1 pl-1.5 pr-2.5 text-[11.5px] text-fg"
              >
                <span
                  className="grid h-5 w-5 place-items-center rounded"
                  style={{ background: `var(${COLOR_VAR[a.color]})`, opacity: 0.85 }}
                />
                <span className="font-medium">{a.name}</span>
                <button
                  type="button"
                  onClick={() => toggleGenAnchor(a.id)}
                  aria-label={`Remove ${a.name} reference`}
                  className="text-fg-faint hover:text-fg"
                >
                  ×
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={() => setRefPickerOpen((o) => !o)}
              aria-expanded={refPickerOpen}
              className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--border)] px-2.5 py-1 text-[11.5px] text-fg-muted hover:text-fg"
            >
              + Add anchor
            </button>
            {refPickerOpen && (
              <div
                className="absolute left-0 top-full z-10 mt-1 grid w-full max-w-xs gap-1 rounded-lg border border-[var(--border)] bg-surface p-2 shadow-lg"
              >
                {drawerAnchors.length === 0 ? (
                  <span className="px-1 py-1 text-[11px] text-fg-muted">
                    No anchors in this project yet — ask your Chi to generate one.
                  </span>
                ) : (
                  drawerAnchors.map((a) => (
                    <button
                      type="button"
                      key={a.id}
                      onClick={() => toggleGenAnchor(a.id)}
                      className="flex items-center justify-between rounded px-2 py-1 text-left text-[11.5px] hover:bg-raised"
                    >
                      <span className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full" style={{ background: `var(${COLOR_VAR[a.color]})` }} />
                        {a.name}
                      </span>
                      {genAnchorIds.includes(a.id) && <span style={{ color: 'var(--achievement)' }}>✓</span>}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        <hr className="border-t border-soft" />

        {/* engine picker */}
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-fg-faint">
            <span>Engine</span>
            <span className="normal-case tracking-normal text-fg-faint">generation track</span>
          </div>
          <div role="radiogroup" aria-label="Choose generation engine" className="grid gap-2">
            {trackAEngines.length === 0 ? (
              <div className="rounded-lg border border-[var(--border)] bg-raised px-3 py-2 text-[11.5px] text-fg-faint">
                No render engines reported by this build.
              </div>
            ) : (
              trackAEngines.map((e) => (
                <label
                  key={e.id}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5"
                  style={{
                    borderColor: genEngine === e.id ? 'var(--agent)' : 'var(--border)',
                    background: genEngine === e.id ? 'color-mix(in oklab, var(--agent-soft) 60%, var(--bg-raised))' : 'var(--bg-raised)',
                  }}
                >
                  <input
                    type="radio"
                    name="gen-engine"
                    checked={genEngine === e.id}
                    onChange={() => setGenEngine(e.id)}
                    style={{ accentColor: 'var(--agent)' }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-fg">
                      {engineDisplayName(e.id)}
                      <span
                        className="rounded px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider"
                        style={{ background: 'var(--agent-soft)', color: 'var(--agent)' }}
                      >
                        Track A
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-fg-muted">
                      Ikenga generates directly — cost + seed tracked here.
                    </div>
                  </div>
                </label>
              ))
            )}
            <label
              className="flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5"
              style={{
                borderColor: isHandoff ? 'var(--agent)' : 'var(--border)',
                background: isHandoff ? 'color-mix(in oklab, var(--agent-soft) 60%, var(--bg-raised))' : 'var(--bg-raised)',
              }}
            >
              <input
                type="radio"
                name="gen-engine"
                checked={isHandoff}
                onChange={() => setGenEngine(HANDOFF_ENGINE_ID)}
                style={{ accentColor: 'var(--agent)' }}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-fg">
                  Higgsfield
                  <span
                    className="rounded border px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-fg-muted"
                    style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-surface)' }}
                  >
                    Track B · handoff
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] text-fg-muted">
                  Copy the prompt package, generate externally, drop the returned clip back in.
                </div>
              </div>
            </label>
          </div>
        </div>

        {/* fal model — the one Track-A adapter with a model choice, so the
            picker appears only for it rather than implying every engine has
            one. Threaded as the render `variant`, not a persisted Cell field. */}
        {isFal && (
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-fg-faint">
              <span>Model</span>
              <span className="normal-case tracking-normal text-fg-faint">fal endpoint</span>
            </div>
            <select
              value={genModel}
              onChange={(e) => setGenModel(e.target.value)}
              aria-label="fal model"
              className="w-full rounded-lg border border-[var(--border)] bg-raised px-2.5 py-2 font-mono text-[12.5px] text-fg outline-none focus:border-[var(--agent)]"
            >
              <option value={FAL_MODEL_AUTO}>auto — image-to-video when anchored</option>
              {FAL_MODELS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <div className="text-[11px] leading-relaxed text-fg-faint">
              {genModel === FAL_MODEL_AUTO
                ? "Uses this cell's own model setting if it has one, and otherwise switches to image-to-video when an anchor is attached — so the reference plate conditions the shot."
                : 'Pinned — overrides this cell\'s own model setting, and an attached anchor will not switch this to image-to-video.'}
            </div>
          </div>
        )}

        {/* seed */}
        {!isHandoff && (
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-fg-faint">
              <span>Seed</span>
              <span className="normal-case tracking-normal text-fg-faint">locks the same visual roll</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                inputMode="numeric"
                value={genSeed}
                disabled={!genSeedLocked}
                onChange={(e) => {
                  const n = Number(e.target.value.replace(/[^0-9]/g, ''));
                  if (Number.isFinite(n)) setGenSeed(n);
                }}
                aria-label="Seed value"
                className="flex-1 rounded-lg border border-[var(--border)] bg-raised px-2.5 py-2 font-mono text-[13px] text-fg outline-none focus:border-[var(--agent)] disabled:text-fg-muted"
              />
              <button
                type="button"
                onClick={() => setGenSeedLocked((l) => !l)}
                aria-pressed={genSeedLocked}
                aria-label="Lock seed"
                title={genSeedLocked ? 'Seed locked — Generate reuses it' : 'Seed unlocked — Generate randomizes it'}
                className="grid h-[34px] w-[34px] flex-none place-items-center rounded-lg border"
                style={{
                  borderColor: genSeedLocked ? 'color-mix(in oklab, var(--achievement) 40%, var(--border))' : 'var(--border)',
                  background: genSeedLocked ? 'var(--achievement-soft)' : 'var(--bg-raised)',
                  color: genSeedLocked ? 'var(--achievement)' : 'var(--fg-muted)',
                }}
              >
                {genSeedLocked ? '🔒' : '🔓'}
              </button>
            </div>
          </div>
        )}

        {/* handoff package + return-leg (Track B) */}
        {isHandoff && (
          <div className="grid gap-2 rounded-lg border border-[var(--border-soft)] bg-raised p-3">
            {!handoffPkg ? (
              <div className="text-[11.5px] text-fg-muted">
                Generate below to package this cell's prompt for Higgsfield.
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">
                    prompt package · {handoffPkg.count} cell{handoffPkg.count === 1 ? '' : 's'}
                  </span>
                  <button
                    type="button"
                    onClick={onCopyHandoffPrompt}
                    className="rounded px-2 py-1 text-[11px] text-fg-muted ring-1 ring-inset ring-[var(--border)] hover:text-fg"
                  >
                    {handoffCopied ? 'Copied ✓' : 'Copy prompt'}
                  </button>
                </div>
                <div className="font-mono text-[10px] text-fg-faint">{handoffPkg.path}</div>
              </>
            )}
            {handoffError && <div className="text-[11px]" style={{ color: 'var(--danger)' }}>Couldn't package — {handoffError}</div>}

            <div className="mt-1 grid gap-1.5 border-t border-soft pt-2.5">
              <div className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">Attach returned clip</div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={ingestPath}
                  onChange={(e) => setIngestPath(e.target.value)}
                  placeholder="/path/to/returned-clip.mp4"
                  disabled={!hasRealCells}
                  className="flex-1 rounded-lg border border-[var(--border)] bg-base px-2.5 py-1.5 font-mono text-[12px] text-fg outline-none focus:border-[var(--agent)] disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={onIngest}
                  disabled={!hasRealCells || ingestBusy || !ingestPath.trim()}
                  className="flex-none rounded-lg px-3 py-1.5 text-[11.5px] text-fg-muted ring-1 ring-inset ring-[var(--border)] hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {ingestBusy ? 'Attaching…' : 'Attach'}
                </button>
              </div>
              {ingestError && <div className="text-[11px]" style={{ color: 'var(--danger)' }}>{ingestError}</div>}
              {!hasRealCells && <div className="text-[11px] text-fg-faint">Attaching a returned clip needs a real project.</div>}
            </div>
          </div>
        )}

        {/* generate CTA */}
        <div className="grid gap-1.5">
          <button
            type="button"
            onClick={onGenerate}
            disabled={generating || promptMissing}
            title={promptMissing ? 'Write a prompt first — this cell has none yet' : undefined}
            className={
              'flex h-10 items-center justify-center gap-1.5 rounded-lg font-medium ' +
              (promptMissing ? 'cursor-not-allowed opacity-40' : 'disabled:cursor-wait disabled:opacity-60')
            }
            style={{ background: 'var(--agent)', color: 'hsl(270,40%,97%)' }}
          >
            {generating ? '● Generating…' : isHandoff ? '✦ Package prompt' : '✦ Generate shot'}
          </button>
          <div className="text-center text-[11px] text-fg-faint">
            {promptMissing
              ? 'Write a prompt above to generate this shot.'
              : isHandoff
              ? 'Packages the prompt for Higgsfield — nothing renders here directly.'
              : 'Adds a new variant to the tray below — nothing is overwritten.'}
          </div>
        </div>
      </div>
    </div>
  );
}
