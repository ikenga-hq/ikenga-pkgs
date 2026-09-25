// com.ikenga.studio · Breakdown view
//
// Concept: plans/studio/designs/redesign-ai/breakdown-b-reframed.html (Dusk
// Wood, LOCKED). Decisions: plans/studio/19-breakdown-conformance.md (D-1..D-7).
//
// Script → board + assets in one pass: the project's Fountain screenplay on
// one side, the extracted shots (cell = shot) + extracted anchors on the
// other, with a bezier connector rail linking a script action line to the
// shot it produced. Two header actions anchor the pane (D-2): a mechanical
// "Scaffold shots" and a "Send to your Chi" handoff for the judgment half.
//
// REAL seams (no fabricated data in real mode):
//   • Script          — storyboard.read_fountain (Wave-5 seam, same as
//     Script.tsx's Fountain mode). `exists:false` is an honest "no
//     script.fountain on disk" state, not an error. Parsed by the SHARED
//     parser (@ikenga/studio-schema/fountain, D-6) — the same code the
//     sidecar's `breakdown.run` segments with, so what this pane counts and
//     what the verb creates cannot drift.
//   • Title card      — `FountainDoc.titlePage`, the script's authored
//     `Key: Value` header (D-5). Rendered as its own card rather than leaked
//     into the body as action lines or silently dropped. Keys are VERBATIM
//     from the source (`Draft date` really has a space + lowercase 'd'), so
//     nothing here assumes a key exists.
//   • Shots           — the hydrated Cell[] (storyboard-store), one shot per
//     cell. `label`/`shot_type`/`action`/`anchors` come straight off the
//     schema — nothing here is invented per-cell copy.
//   • Anchors         — anchor.list (real project anchors); "used in N shots"
//     is counted from the real `cell.anchors` arrays, not a canned number.
//     Descriptions read `metadata.prompt ?? metadata.description` — the skill
//     and `anchor.generate` both write `prompt`; `description` is the older
//     key nothing on this codepath writes any more (kept as a fallback).
//   • Engine chip     — REAL, and only where it is real (D-3). `Cell.renderer`
//     CANNOT carry the truth: it is the *pick/intent* (and since WP-32/G-68 its
//     enum does include `fal` + `blender`), not what actually ran. Engine +
//     model live on
//     `RenderRecord.engine` + `.model_id`, and only AFTER something rendered.
//     The chip therefore requires a record whose `status === 'done'` — NOT
//     merely a record's existence. `recordByUid` ranks done>running>queued>
//     failed/cancelled but FILTERS NOTHING, so it happily returns a queued or
//     failed record; chipping off that claimed "engine that rendered this
//     shot" when nothing rendered (Round-2 defect #1). A shot with no `done`
//     record keeps the labelled Track pill. We never predict an engine and
//     print it as fact.
//   • Script refresh  — REAL EVENT SEAM, not a poll. The script text is this
//     view's own fetch (it is NOT in the storyboard store), so an EXTERNAL
//     write — the Chi running studio-breakdown, an editor, `breakdown.run`
//     from another pane — used to leave this pane rendering pre-write text
//     forever. There is now a `cells/changed` subscription; the chain is
//     code-verified end to end:
//       sidecars/project/src/watcher.ts WATCH_GLOBS includes 'script.fountain'
//       → chokidar 'change' → onEvent('updated') → deriveCellId returns
//       `project:script.fountain` → emitCellsChanged → topic
//       `pkg://com.ikenga.studio/cells/changed` → bridge.ts's
//       dispatchIncomingLoggingNotification → fanOutStudioEvent →
//       subscribeStudioEvent. `storyboard.write_fountain` writes that exact
//       path, so the event really does fire for a tag write.
//     Two honest limits, which is why the manual "Re-read script" control in
//     the Script column header is NOT redundant belt-and-braces:
//       1. The relay only exists INSIDE the shell — standalone dev has no
//          parent window, so no frame ever arrives and nothing auto-refreshes.
//       2. This round verified the seam by READING the code end to end; it is
//          not live-verified. So the UI never PROMISES auto-refresh — it says
//          the pane re-reads when the project reports a change, and leaves the
//          manual control visible for when it doesn't.
//     The subscription deliberately does NOT filter on the changed uid: the
//     precise filter (`changed_uids` contains `project:script.fountain`) would
//     fail SILENTLY if that derivation ever drifts — the exact class of bug
//     this seam exists to fix. An extra idempotent read is the cheap side.
//   • Track A/B pill  — a HEURISTIC, not a stored field: the schema has no
//     per-cell "generator track". We ask render.list_engines once and treat a
//     cell as Track A (fal, in-app) when a `fal*` engine capability advertises
//     `video: true` and the cell's duration fits `max_duration_ms` (which fal
//     really reports as `null` — no advertised cap, so no basis to demote).
//     Anything else is Track B (handoff to an external tool). Labelled as an
//     estimate in the UI, never asserted as ground truth.
//     In DEMO mode there is no matrix at all and none is fetched (the engines
//     effect early-returns on `!hasRealCells`): the demo Track values are
//     HARDCODED literals on DEMO_SHOTS, which never touch `trackForCell`. So
//     every demo-mode track affordance says "fixed value in the demo fixture"
//     and none of them cite a capability matrix — citing one there is the same
//     fabrication `unknown` was added to prevent, just on the other codepath.
//     The matrix can also FAIL TO LOAD, and that is a third state, not Track
//     B: with `engines: []` the heuristic returns B for every cell, which is
//     indistinguishable from a genuine all-Track-B board (Round-2 defect #11).
//     So the fetch outcome is tracked, and until the matrix is actually in
//     hand every track reads `unknown` — we do not cite a capability matrix we
//     do not have.
//   • Facts strip     — counts + the Track split ONLY. There is deliberately
//     NO cost figure (D-4): `EngineCapability` carries no price field and cost
//     is post-hoc on `RenderRecord.cost_estimate/cost_actual`, so any dollar
//     amount rendered before a run would be fiction. The sibling Canvas view
//     banned money on this board for the same reason.
//   • Scaffold / Tag  — `breakdown.run` (breakdownApi). Deterministic and
//     free; two auto-selected modes (D-8). An EMPTY board is SCAFFOLDED: one
//     rung-0 cell per action paragraph + the `[[sc<N>_sh<M>]]` tags written
//     back into script.fountain. A board that already HAS cells is RETAGGED —
//     nothing is created (`created: []` in retag is by design, not a failure),
//     only tags are written. Nothing is rendered, no anchor is generated,
//     nothing is spent. Created cells come back `shot_type:'unset'`,
//     `prompt:''`, `anchors:[]` — the honest shape of a scaffold awaiting
//     judgment, not missing data to paper over.
//     **The result is a discriminated union — switch on `outcome`.** A resolved
//     promise does NOT mean the board changed: `ambiguous-needs-chi` (matching
//     is judgment — the real forge project is 8 paragraphs vs 6 cells),
//     `already-tagged`, `script-write-failed`, `planned` and `demo-inert` all
//     arrive as normal results because each carries facts the user needs. Only
//     `no-script` / `no-action-paragraphs` / `invalid-args` throw. `tagged` is
//     a LIST (there is no "tags written" number to invent) and `script_bytes`
//     is `null` when nothing was written — never coalesced to 0, because 0
//     reads as a measurement.
//   • Send to your Chi — `host.sendToActiveSession` via bridge.ts's sendToChi,
//     gated on manifest `permissions.engine: ["invoke"]`. This is the half
//     `run` refuses to fake: segmentation judgment, shot_type/camera
//     inference and anchor extraction need an LLM, and the studio-breakdown
//     skill already owns that prose (and, as of this round, owns writing the
//     `[[tags]]` too — which is what makes the tag-only rail below reachable).
//     The prompt BRANCHES ON BOARD STATE, and that branch is load-bearing, not
//     cosmetic. The skill's own first instruction is "two branches, decided by
//     the board": an empty board scaffolds, a board WITH cells retags and
//     creates nothing. A prompt that unconditionally asks to "segment it into
//     shots… then write the cells" hands the skill the scaffold branch on a
//     board that already has shots — and nothing downstream stops it, because
//     the new cells get fresh uids and `create_cell` only rejects DUPLICATE
//     uids. On the real forge board that is 8 new cells minted alongside the
//     existing 6: a 14-shot board, from one click, with no error. So an
//     existing board gets a tag-only request that says "do not create, delete
//     or reorder cells" out loud.
//     The copy is a REQUEST, never a guarantee. The studio-breakdown skill is
//     a separate, CI-published package (`@ikenga/studio-breakdown`) and
//     is the single source of truth for the tag procedure — this pane does not
//     carry a duplicate copy of it. Consequently the pane CANNOT know whether
//     the Chi on the other end has the skill installed. If it doesn't, it says
//     so in the chat pane, which is the honest failure. Nothing here asserts
//     the tags WILL be written.
//     `scope-denied` / `no-active-session` / `no-host` are surfaced inline,
//     never swallowed, and each blames the thing that actually refused:
//     `scope-denied` is the SHELL's manifest-scope check firing before the Chi
//     is ever reached, so it is not the Chi refusing anything.
//
// Line→shot linking (D-1a) — TAG-ONLY. There is no positional fallback:
//   1. An action block that carries a `[[tag]]` (parser → `FountainBlock.tag`)
//      links EXACTLY to the shot whose uid (preferred) or shotId equals it.
//      Untagged or unmatched paragraphs stay unlinked.
//   2. That's it. The positional fallback this file used to carry (Nth
//      paragraph → Nth shot over `min()`) is DELETED, not disabled: on the real
//      forge script paragraph 0 is establishing/style prose and paragraph 1 is
//      the first actual shot, so every one of its six links was off by one and
//      the pane confidently badged `c1-forge` onto a paragraph describing the
//      room. A disclosed guess is still a wrong answer. We draw no line rather
//      than a line we know may be wrong.
//   3. So an untagged script draws an EMPTY rail — which must not be a dead
//      gutter. The gutter offers the way out instead: one quiet affordance that
//      hands the script to the Chi to tag. That is the whole reason dropping
//      the fallback is acceptable — the empty state is one click from correct.
//      That claim is only TRUE because of the `cells/changed` subscription
//      above. Without it the click wrote tags the pane never re-read, so the
//      rail stayed empty and the affordance sat there inviting the same
//      request again — "one click from correct" was one click plus an
//      undiscoverable remount.
//   4. The affordance is gated on tagging being INCOMPLETE (`linked < shots`),
//      NOT on the rail being empty. A 5-of-6 rail is very reachable — the skill
//      is explicitly told to leave a shot it can't confidently match untagged,
//      so a partial rail is a DESIGNED outcome, not an edge case. Hiding the
//      affordance at the first nonzero match stranded exactly the user the
//      skill's own honesty rule creates. The incompleteness is stated as a
//      count rather than implied by a missing line.
// Because unmatched paragraphs and shots are unlinked, every `linkId` is
// optional and must be guarded before it is used as a ref key / hover key.
//
// Dialogue: this archetype's screenplay format has no dialogue — any
// character-cue/dialogue block a parsed `.fountain` happens to contain is
// filtered out before rendering (dialogue kind from the shared parser), so
// only the title card + scene headings + action lines ever show here.
//
// Mock/standalone: __mocks__ has no Breakdown-shaped fixture (no dedicated
// screen predates this view), so a small local "The Forge" demo — matching
// the design concept 1:1, rail included — stands in only when `hasRealCells`
// is false. It is clearly labelled "Demo data" and never conflated with a real
// project. DEMO_FOUNTAIN is deliberately TAGGED: the rail is tag-only (D-1a),
// so an untagged demo would draw no rail and the concept's signature feature
// would be invisible in the pkg's own dev loop. Keep the tags in step with
// DEMO_SHOTS' uids — if they drift apart the demo rail silently goes dark.

import { useEffect, useMemo, useRef, useState } from 'react';

import { useProjectStore, selectOpenProject } from '../project-store';
import {
  useStoryboardStore,
  selectHasRealCells,
  selectHydratedCells,
  selectHydratedProject,
  selectRenderRecords,
} from '../storyboard-store';
import { useAnchorsStore, selectAnchors, selectAnchorsError } from '../anchors-store';
import { getMcpClient, storyboardApi, renderApi, breakdownApi } from '../mcp-client';
import { sendToChi, subscribeStudioEvent } from '../bridge';
import { parseFountain, type FountainDoc, type FountainScene } from '../lib/fountain';
// D-1a tag→shot linking. Shared with the node canvas's beat→shot edges (G-57).
import { computeLinking } from '../lib/tag-linking';
import type { Anchor, Cell, EngineCapability, RenderRecord } from '../mcp-types';
import { EmptyState } from '../components/EmptyState';
import { recordByUid, engineLabel } from './composition/format';
import { CellPoster, prefetchPosters } from './composition/CellPoster';

// ─── local "The Forge" demo fixture (standalone/mock only) ───────────────

interface DemoShot {
  uid: string;
  shotId: string;
  shotType: string;
  action: string;
  anchorIds: string[];
  renderer: string;
  /** A FIXED LITERAL, not an estimate. Demo mode never fetches the engine
   *  capability matrix (the engines effect early-returns on `!hasRealCells`)
   *  and these values never pass through `trackForCell`. They exist so the
   *  demo matches the design concept 1:1 — so every affordance that renders
   *  them must say "demo fixture" and must NOT cite a matrix that was never
   *  fetched. See the file header's Track A/B note. */
  track: 'A' | 'B';
}

const DEMO_ANCHORS: Anchor[] = [
  {
    id: 'a-adaora', name: 'Adaora', kind: 'character',
    asset: { uri: 'demo://adaora.png' },
    tags: [], metadata: { seed: 44821, description: 'Young West African blacksmith, soot-marked, leather apron, firelit' },
  },
  {
    id: 'a-workshop', name: 'The Workshop', kind: 'location',
    asset: { uri: 'demo://workshop.png' },
    tags: [], metadata: { seed: 90310, description: 'Dim ironworking workshop at night, glowing forge, embers' },
  },
  {
    id: 'a-mask', name: 'Iron mask', kind: 'image',
    asset: { uri: '' },
    tags: [], metadata: { description: 'The object being forged — half-formed, then alive' },
  },
  {
    id: 'a-style', name: 'Ember-noir', kind: 'style',
    asset: { uri: 'demo://ember-noir.png' },
    tags: [], metadata: { seed: 10577, description: 'Warm orange key against deep shadow, cinematic, shallow DoF' },
  },
];

const DEMO_SHOTS: DemoShot[] = [
  { uid: 'sc1_sh1', shotId: 'sc1_sh1', shotType: 'ws',  action: 'Forge glowing, slow push-in, embers',              anchorIds: ['a-workshop'],             renderer: 'auto', track: 'A' },
  { uid: 'sc1_sh2', shotId: 'sc1_sh2', shotType: 'ms',  action: 'Adaora at anvil, hammer raised, firelight',        anchorIds: ['a-adaora', 'a-workshop'], renderer: 'auto', track: 'A' },
  { uid: 'sc1_sh3', shotId: 'sc1_sh3', shotType: 'ecu', action: 'Iron mask half-formed, slow tilt, sparks',         anchorIds: ['a-workshop', 'a-mask'],   renderer: 'auto', track: 'A' },
  { uid: 'sc1_sh4', shotId: 'sc1_sh4', shotType: 'cu',  action: 'Hammer strikes, sparks burst toward camera',       anchorIds: ['a-adaora'],               renderer: 'auto', track: 'B' },
  { uid: 'sc1_sh5', shotId: 'sc1_sh5', shotType: 'ecu', action: "Mask's eyes catch firelight, a flicker",           anchorIds: ['a-workshop', 'a-mask'],   renderer: 'auto', track: 'A' },
  { uid: 'sc1_sh6', shotId: 'sc1_sh6', shotType: 'ms',  action: 'Adaora steps back, mask glowing between',          anchorIds: ['a-adaora', 'a-workshop'], renderer: 'auto', track: 'A' },
];

// Tagged, because the rail is tag-only (D-1a) and an untagged demo would render
// the concept's signature feature as a bare gutter. A tagged script is simply
// what a broken-down script looks like once `breakdown.run` (or your Chi) has
// been over it — the tags below are the same `[[uid]]` notes those paths write.
// Each value matches a DEMO_SHOTS uid, so every one resolves through byKey.
const DEMO_FOUNTAIN = `INT. THE WORKSHOP - NIGHT

The forge glows low and orange in the dark. Embers drift upward like slow stars. [[sc1_sh1]]

Adaora stands at the anvil, soot on her hands, hammer raised, firelight carving her face out of shadow. [[sc1_sh2]]

Close on the anvil: an iron mask, half-formed, catches sparks as it turns beneath the hammer's shadow. [[sc1_sh3]]

The hammer falls. Sparks burst toward camera — a shower of white fire against black. [[sc1_sh4]]

The mask's eyes catch the firelight. A flicker. Almost alive. [[sc1_sh5]]

Adaora steps back. Between her hands the mask glows, held like something newborn. [[sc1_sh6]]
`;

const DEMO_TITLE = 'The Forge';

// ─── shared shot shape (post-projection from Cell OR the demo fixture) ───

/** Which generator track a shot is estimated to take — or `unknown` when we
 *  have no engine capability matrix to estimate from (failed/pending fetch).
 *  `unknown` is a THIRD state on purpose: silently reporting 'B' when the
 *  matrix never loaded is indistinguishable from a real all-Track-B board. */
type Track = 'A' | 'B' | 'unknown';

interface ShotRow {
  uid: string;
  shotId: string;
  shotType: string;
  action: string;
  anchorIds: string[];
  renderer: string;
  track: Track;
  /** The shot's `done` RenderRecord, when something really rendered for it.
   *  The ONLY honest source of engine + model (D-3) — `Cell.renderer` is the
   *  pick/intent (it now includes `fal`/`blender` since WP-32/G-68), not what
   *  actually ran, so it cannot answer this. Undefined = nothing has
   *  successfully rendered (no record at all, or only queued/running/failed/
   *  cancelled ones), and we fall back to the labelled Track pill rather than
   *  claiming an engine "rendered this shot" when none did. */
  record?: RenderRecord;
}

function cellToShot(cell: Cell, track: Track, record?: RenderRecord): ShotRow {
  return {
    uid: cell.uid,
    shotId: cell.label || cell.beat_id || cell.uid,
    shotType: cell.shot_type ?? 'unset',
    action: cell.action || cell.intent || cell.prompt || '(no action note yet)',
    anchorIds: cell.anchors ?? [],
    renderer: cell.renderer ?? 'auto',
    track,
    record,
  };
}

/** Track A/B heuristic — see file-header note. Cheap, best-effort, never
 *  presented as authoritative.
 *
 *  `matrix` is the engine capability list ONLY once it really loaded; `null`
 *  means the render.list_engines fetch failed or hasn't answered yet, and the
 *  answer is `unknown` rather than the 'B' the heuristic would fall through to
 *  on an empty list (Round-2 defect #11 — that 'B' reads as a finding). */
function trackForCell(cell: Cell, matrix: EngineCapability[] | null): Track {
  if (matrix === null) return 'unknown';
  const fal = matrix.find((e) => e.id.toLowerCase().includes('fal'));
  if (!fal || fal.video !== true) return 'B';
  // `max_duration_ms` is genuinely nullable on the wire (fal reports null — no
  // advertised cap). Null means we have no basis to demote the shot, so it
  // stays Track A; only a real cap that a real duration exceeds sends it to B.
  if (fal.max_duration_ms != null && cell.duration_ms && cell.duration_ms > fal.max_duration_ms) return 'B';
  return 'A';
}

/** `fal-ai/ltx-video` → `ltx-video`. Drops the owner prefix for the chip's
 *  short name; the full id stays in the chip's title attribute. */
function shortModelId(id: string): string {
  const slash = id.indexOf('/');
  return slash === -1 ? id : id.slice(slash + 1);
}

/** Anchor description: `metadata.prompt` is what the studio-breakdown skill and
 *  `anchor.generate` actually write. `metadata.description` is the older key —
 *  nothing on this codepath writes it any more, but real projects may still
 *  carry it, so it stays as a fallback. Reading `description` FIRST (as this
 *  did) is why every anchor rendered blank. */
function anchorMeta(a: Anchor): { seed?: number; description?: string } {
  const md = a.metadata ?? {};
  const prompt = typeof md.prompt === 'string' ? md.prompt : undefined;
  const description = typeof md.description === 'string' ? md.description : undefined;
  return {
    seed: typeof md.seed === 'number' ? md.seed : undefined,
    description: prompt ?? description,
  };
}

// ─── line↔shot linking (D-1a) ────────────────────────────────────────────
//
// `computeLinking` moved to `../lib/tag-linking` (imported above) when Plan 25's
// node canvas needed the SAME mechanism for its beat → shot edges (G-57:
// "reuse that mechanism; do not invent a second one"). The rule and its
// rationale live with the function; nothing about this pane's behaviour
// changed. `ShotRow` structurally satisfies `LinkableShot` (uid + shotId), so
// the call site below is unchanged.

// ─── rail (bezier connector) ──────────────────────────────────────────────

function BreakdownRail({
  activeId,
  paraRefs,
  shotRefs,
  railRef,
  scriptScrollRef,
  shotScrollRef,
  ids,
}: {
  activeId: string | null;
  paraRefs: React.MutableRefObject<Map<string, HTMLElement>>;
  shotRefs: React.MutableRefObject<Map<string, HTMLElement>>;
  railRef: React.RefObject<HTMLDivElement | null>;
  /** The two `overflow-y-auto` columns the rail spans. Every endpoint y is a
   *  viewport measurement, so ANY scroll in either column invalidates every
   *  path — without these the beziers visibly detach from their endpoints the
   *  moment the user scrolls (Round-2 defect #4). Passed as two named refs
   *  rather than an array so the effect's dep list stays stable across
   *  renders. */
  scriptScrollRef: React.RefObject<HTMLDivElement | null>;
  shotScrollRef: React.RefObject<HTMLDivElement | null>;
  ids: string[];
}) {
  const [paths, setPaths] = useState<Array<{ id: string; d: string; x1: number; y1: number; x2: number; y2: number }>>([]);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const recompute = () => {
      const rail = railRef.current;
      if (!rail) return;
      const railRect = rail.getBoundingClientRect();
      setBox({ w: railRect.width, h: railRect.height });
      const next: typeof paths = [];
      for (const id of ids) {
        const p = paraRefs.current.get(id);
        const s = shotRefs.current.get(id);
        if (!p || !s) continue;
        const pRect = p.getBoundingClientRect();
        const sRect = s.getBoundingClientRect();
        const y1 = pRect.top + pRect.height / 2 - railRect.top;
        const y2 = sRect.top + sRect.height / 2 - railRect.top;
        const x1 = 0;
        const x2 = railRect.width;
        const midX = railRect.width / 2;
        next.push({
          id,
          d: `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`,
          x1, y1, x2, y2,
        });
      }
      setPaths(next);
    };

    // Scroll fires at input rate; coalesce every trigger onto one rAF tick so
    // we measure at most once per painted frame (and always right before the
    // paint that shows it).
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        recompute();
      });
    };

    recompute();
    const ro = new ResizeObserver(schedule);
    if (railRef.current) ro.observe(railRef.current);
    window.addEventListener('resize', schedule);
    const t = setTimeout(recompute, 50);

    // Both columns scroll independently, and the rail spans them — so both are
    // sources of desync, not just the taller one.
    const scrollers = [scriptScrollRef.current, shotScrollRef.current].filter(
      (el): el is HTMLDivElement => el !== null,
    );
    for (const el of scrollers) el.addEventListener('scroll', schedule, { passive: true });

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      for (const el of scrollers) el.removeEventListener('scroll', schedule);
      clearTimeout(t);
      if (frame) cancelAnimationFrame(frame);
    };
    // Re-measure whenever the set of linkable ids changes (data load) too.
  }, [ids, paraRefs, shotRefs, railRef, scriptScrollRef, shotScrollRef]);

  return (
    // Fills its parent gutter column rather than sizing itself, so the
    // incomplete-tagging affordance can overlay the same 44px lane without
    // shortening the rail (every endpoint y is measured against THIS box).
    <div ref={railRef} className="relative min-h-0 w-full flex-1" aria-hidden="true">
      <svg viewBox={`0 0 ${box.w} ${box.h}`} className="h-full w-full overflow-visible">
        {paths.map((p) => {
          const active = p.id === activeId;
          return (
            <g key={p.id}>
              <path
                d={p.d}
                fill="none"
                stroke={active ? 'var(--agent)' : 'var(--border)'}
                strokeWidth={active ? 1.75 : 1.25}
              />
              <circle cx={p.x1} cy={p.y1} r={2.5} fill="var(--bg-base)" stroke={active ? 'var(--agent)' : 'var(--border)'} strokeWidth={1.25} />
              <circle cx={p.x2} cy={p.y2} r={2.5} fill={active ? 'var(--agent)' : 'var(--bg-base)'} stroke={active ? 'var(--agent)' : 'var(--border)'} strokeWidth={1.25} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─── view ─────────────────────────────────────────────────────────────────

export function BreakdownView() {
  const project = useProjectStore(selectOpenProject);
  const hasRealCells = useStoryboardStore(selectHasRealCells);
  const hydratedCells = useStoryboardStore(selectHydratedCells);
  const projectDoc = useStoryboardStore(selectHydratedProject);
  const renderRecords = useStoryboardStore(selectRenderRecords);
  const refetchStoryboard = useStoryboardStore((s) => s.refetch);

  useEffect(() => { void refetchStoryboard(); }, [refetchStoryboard]);

  // archetype (projectDoc.script.archetype / archetype_id) drives the scene +
  // dialogue parsing below; non-narrative formats have no dialogue by design.
  const title = hasRealCells ? (projectDoc?.script?.title ?? projectDoc?.title ?? 'script') : DEMO_TITLE;
  // real projects always persist the screenplay to <root>/script.fountain (see mcp-client.ts:199-201)
  const scriptFilename = hasRealCells ? 'script.fountain' : 'the-forge.fountain';

  // ── anchors (shared store — review §2.4 — real: anchor.list via the
  // store; mock: DEMO_ANCHORS) ──
  const storeAnchors = useAnchorsStore(selectAnchors);
  const storeAnchorsError = useAnchorsStore(selectAnchorsError);
  const ensureAnchors = useAnchorsStore((s) => s.ensure);
  useEffect(() => {
    if (hasRealCells && project?.project_id) ensureAnchors(project.project_id);
  }, [hasRealCells, project?.project_id, ensureAnchors]);
  const anchors = hasRealCells ? storeAnchors : DEMO_ANCHORS;
  const anchorsError = hasRealCells ? storeAnchorsError : null;

  // ── engines (real only — powers the Track A/B heuristic) ──
  //
  // `null` means we do NOT have the capability matrix: the fetch failed, or it
  // hasn't answered yet. It is NOT the same as a matrix that loaded and lists
  // no fal engine. This used to `setEngines([])` on failure, which silently
  // demoted every shot to Track B and then let the tooltip cite "the engine
  // capability matrix" — a matrix we didn't have (Round-2 defect #11).
  const [engines, setEngines] = useState<EngineCapability[] | null>(null);
  const [enginesFailed, setEnginesFailed] = useState(false);
  useEffect(() => {
    if (!hasRealCells) return;
    let cancelled = false;
    void (async () => {
      try {
        const client = await getMcpClient();
        const res = await renderApi.list_engines(client);
        if (!cancelled) { setEngines(res.engines ?? []); setEnginesFailed(false); }
      } catch {
        // Keep the matrix null — the tracks stay honestly unknown.
        if (!cancelled) { setEngines(null); setEnginesFailed(true); }
      }
    })();
    return () => { cancelled = true; };
  }, [hasRealCells, project?.project_id]);

  // ── fountain script (real: storyboard.read_fountain; mock: DEMO_FOUNTAIN) ──
  const [fountain, setFountain] = useState<{
    loading: boolean; loaded: boolean; exists: boolean; text: string; error: string | null;
  }>({ loading: false, loaded: false, exists: false, text: '', error: null });

  // The script text is NOT in the storyboard store — this view owns its own
  // read_fountain fetch. So the store's `refetch()` alone will NOT refresh the
  // script pane or show the tags `breakdown.run` just wrote; bumping this nonce
  // is what re-runs the read. Both are fired after a real scaffold.
  const [fountainNonce, setFountainNonce] = useState(0);
  const rereadScript = () => {
    void refetchStoryboard();
    setFountainNonce((n) => n + 1);
  };

  // ── the chain-closer: re-read on an EXTERNAL write ──
  //
  // Bumping the nonce from `runBreakdown` only covers writes THIS pane made.
  // The whole point of the Chi handoff is that someone ELSE writes the tags —
  // and that write used to be invisible here forever: no watcher, no poll, no
  // store subscription (the mount-only refetch above carries cells, never the
  // script text). The user clicked ✦, the Chi correctly wrote six tags, and the
  // pane kept rendering pre-write text with an empty rail and the same ✦ button
  // inviting the request again.
  //
  // `cells/changed` is the real event seam, verified by reading it end to end:
  // the sidecar's watcher globs include 'script.fountain' (watcher.ts
  // WATCH_GLOBS), so `storyboard.write_fountain`'s writeFileSync on that exact
  // path fires chokidar 'change' → emitCellsChanged → the shell's relay →
  // bridge.ts's fanOut → here. It is NOT a poll and NOT a guess.
  //
  // No uid filter on purpose — see the file header. Over-narrow filtering is
  // how this class of bug returns silently; a redundant idempotent read is not.
  useEffect(() => {
    if (!hasRealCells) return; // standalone: no parent window, so no frames arrive
    return subscribeStudioEvent('cells/changed', () => {
      setFountainNonce((n) => n + 1);
    });
  }, [hasRealCells]);

  useEffect(() => {
    if (!hasRealCells) return;
    let cancelled = false;
    setFountain((f) => ({ ...f, loading: true, error: null }));
    void (async () => {
      try {
        const client = await getMcpClient();
        const res = await storyboardApi.read_fountain(client);
        if (!cancelled) setFountain({ loading: false, loaded: true, exists: res.exists, text: res.text, error: null });
      } catch (e) {
        if (!cancelled) setFountain({ loading: false, loaded: true, exists: false, text: '', error: (e as Error).message });
      }
    })();
    return () => { cancelled = true; };
  }, [hasRealCells, project?.project_id, fountainNonce]);

  const scriptText = hasRealCells ? fountain.text : DEMO_FOUNTAIN;
  const scriptExists = hasRealCells ? fountain.exists : true;

  // Parse once — the shared parser (D-6), same code the sidecar segments with.
  const doc: FountainDoc = useMemo(
    () => (scriptText ? parseFountain(scriptText) : { titlePage: null, scenes: [] }),
    [scriptText],
  );

  /** The title page, split for rendering (D-5). Real scripts give keys like
   *  `Title` / `Credit` / `Draft date` / `Notes` — VERBATIM from the source, so
   *  the title is found case-insensitively and every other key is rendered as
   *  authored rather than mapped to a field we assume exists. */
  const titleCard = useMemo(() => {
    const tp = doc.titlePage;
    if (!tp) return null;
    const entries = Object.entries(tp).filter(([, v]) => v.trim().length > 0);
    if (entries.length === 0) return null;
    const titleKey = entries.find(([k]) => k.toLowerCase() === 'title')?.[0];
    return {
      title: titleKey ? tp[titleKey] : undefined,
      rest: entries.filter(([k]) => k !== titleKey),
    };
  }, [doc]);

  // Strip dialogue (this archetype's screenplay has none by design — any
  // character-cue/dialogue block that shows up anyway is not rendered).
  const scenes: FountainScene[] = useMemo(
    () => doc.scenes
      .map((scene) => ({ ...scene, blocks: scene.blocks.filter((b) => b.kind !== 'dialogue') }))
      .filter((scene) => scene.blocks.length > 0),
    [doc],
  );

  /** Every action block, document-order — the unit `breakdown.run` turns into
   *  one cell, and the index `writeShotTags`'s `paragraphIndex` addresses.
   *  Dropping dialogue above cannot shift these (it removes no action block). */
  const actionBlocks = useMemo(
    () => scenes.flatMap((scene) => scene.blocks.filter((b) => b.kind === 'action')),
    [scenes],
  );

  /** Index of each scene's FIRST action block in `actionBlocks` — lets the
   *  script column resolve a block's document-wide index without an O(n²)
   *  re-scan per paragraph. */
  const sceneActionOffsets = useMemo(() => {
    const offsets: number[] = [];
    let acc = 0;
    for (const scene of scenes) {
      offsets.push(acc);
      acc += scene.blocks.filter((b) => b.kind === 'action').length;
    }
    return offsets;
  }, [scenes]);

  // ── per-shot render records (the ONLY honest engine source — D-3) ──
  const recByUid = useMemo(
    () => (hasRealCells ? recordByUid(renderRecords) : {}),
    [hasRealCells, renderRecords],
  );

  // ── shots (real: hydrated Cell[] mapped 1:1; mock: DEMO_SHOTS) ──
  const shots: ShotRow[] = useMemo(() => {
    if (!hasRealCells) return DEMO_SHOTS.map((s) => ({ ...s }));
    return [...hydratedCells]
      .sort((a, b) => a.index - b.index)
      .map((c) => {
        // ONE record source: the polled `render.list` rows. This used to read a
        // second source — `recordByUid(c.renders)` — under a comment claiming
        // "storyboard.read hydrates `Cell.renders`". That claim is FALSE: no
        // sidecar writer populates `Cell.renders`, so a real project's
        // storyboard.json keeps `renders: []` even after a successful render
        // (live-verified, plans/studio/verify/2026-09-12-wp32-live/g61/
        // 2-poster-verdict.md). The fallback contributed nothing and the
        // comment misled the node canvas into sourcing its posters from the
        // same dead field. `render.list` is not session-scoped — it reads the
        // `render_queue` table — so a shot that rendered in an earlier session
        // still resolves its real engine here.
        //
        // `recordByUid` RANKS by status (done>running>queued>failed) but
        // filters nothing — it returns the best record of ANY status. So its
        // result must still be checked: a shot whose only render is queued or
        // failed has rendered NOTHING, and chipping "fal ▸ ltx-video · engine
        // that rendered this shot" onto it is a lie (Round-2 defect #1).
        const best = recByUid[c.uid];
        const done: RenderRecord | undefined = best?.status === 'done' ? best : undefined;
        return cellToShot(c, trackForCell(c, engines), done);
      });
  }, [hasRealCells, hydratedCells, engines, recByUid]);

  // Batch-prefetch the done-render posters so the board thumbs show the real
  // frame (same seam Canvas uses — render.list_posters, one round trip) rather
  // than a bare ember placeholder. `shot.record` is done-only, so this only
  // ever asks for frames that genuinely finished.
  useEffect(() => {
    const ids = shots.map((s) => s.record?.id).filter((id): id is string => !!id);
    if (ids.length > 0) prefetchPosters(ids);
  }, [shots]);

  // Line↔shot linking — TAG-ONLY; unmatched paragraphs/shots unlinked (D-1a).
  const linking = useMemo(() => computeLinking(actionBlocks, shots), [actionBlocks, shots]);

  const anchorUsage = useMemo(() => {
    const counts = new Map<string, number>();
    if (hasRealCells) {
      for (const c of hydratedCells) for (const id of c.anchors ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
    } else {
      for (const s of DEMO_SHOTS) for (const id of s.anchorIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [hasRealCells, hydratedCells]);

  // Counted per state, NOT `total - A` — an `unknown` track is not a Track B.
  const trackACount = shots.filter((s) => s.track === 'A').length;
  const trackBCount = shots.filter((s) => s.track === 'B').length;
  const trackUnknownCount = shots.filter((s) => s.track === 'unknown').length;
  /** True while we have no capability matrix to estimate tracks from. */
  const noTrackMatrix = hasRealCells && engines === null;
  const pendingAnchors = anchors.filter((a) => !a.asset?.uri).length;

  /** How many shots actually have a line drawn to them. NOT the same as
   *  `taggedParagraphs`: a tag naming a shot that isn't on the board is tagged
   *  but unlinked, so it counts there and not here. */
  const linkedShotCount = linking.railIds.length;

  /** Tagging is INCOMPLETE — some shot on this board has no line to a script
   *  paragraph. This, not "the rail is empty", is what gates the ✦ affordance.
   *  A partial rail is a DESIGNED outcome (the skill is told to leave a shot it
   *  can't confidently match untagged), so hiding the way forward at the first
   *  nonzero match strands the user in the state the skill's honesty produces. */
  const tagIncomplete = shots.length > 0 && linkedShotCount < shots.length;

  /** The shots with no line — named, so the Chi request can point at them
   *  instead of asking for a blanket re-tag of work already done. */
  const untaggedShotUids = shots
    .filter((_, i) => linking.shotLink[i] === undefined)
    .map((s) => s.uid);

  /** How the rail is linked right now, stated plainly. Tags are exact; nothing
   *  else links at all (D-1a), so there is no "estimate" wording left here.
   *  Partial coverage is reported as a count rather than implied by a missing
   *  line — "5 of 6 shots tagged" is a fact the user can act on; a silently
   *  short rail looks complete. */
  const railNote =
    linking.mode === 'tag'
      // "tagged" and "linked" are NOT the same number — a tag naming a shot
      // that doesn't exist is tagged but unlinked. Report both.
      ? `rail linked by [[tag]] — exact (${linkedShotCount} of ${shots.length} shots tagged`
        + `; ${linking.taggedParagraphs} of ${actionBlocks.length} paragraphs carry a tag)`
      : 'rail: no [[tags]] in this script yet — nothing to link';

  // ── hover/focus linking state ──
  const [activeId, setActiveId] = useState<string | null>(null);
  const paraRefs = useRef<Map<string, HTMLElement>>(new Map());
  const shotRefs = useRef<Map<string, HTMLElement>>(new Map());
  const railRef = useRef<HTMLDivElement>(null);
  // The two independently-scrolling columns the rail measures across — it has
  // to re-measure on their scroll or every bezier detaches (defect #4).
  const scriptScrollRef = useRef<HTMLDivElement>(null);
  const shotScrollRef = useRef<HTMLDivElement>(null);

  // ── the two CTAs (D-2): a mechanical scaffold + a handoff for the judgment ──
  //
  // They are NOT two flavours of the same button. `breakdown.run` creates cells
  // and writes tags and refuses to invent shot_type / prompt / anchors; the
  // studio-breakdown skill (run by the user's Chi) is the only thing that can
  // supply those. Neither reimplements the other.

  const [busy, setBusy] = useState<null | 'run' | 'chi'>(null);
  /** `info` is a real third tone, not a shade of `ok`: "nothing happened, and
   *  here is why" (demo-inert, already-tagged, a hand-off) is neither a success
   *  to celebrate nor an error to alarm. `action` lets a result that needs
   *  judgment put the way forward — the Chi — one click away. */
  const [notice, setNotice] = useState<
    { tone: 'ok' | 'info' | 'error'; text: string; action?: { label: string; run: () => void } } | null
  >(null);

  /** Which half of D-8 a run would take, decided by the board we can actually
   *  see. An EMPTY board scaffolds; a board with cells retags (nothing is ever
   *  created onto an existing board). The sidecar decides this itself off the
   *  board it reads — this is only how we LABEL the button, so it must never be
   *  used to predict a result. `null` in demo: no board on disk, no mode. */
  const verbMode: 'scaffold' | 'retag' | null = !hasRealCells
    ? null
    : hydratedCells.length > 0 ? 'retag' : 'scaffold';

  /** Both CTAs need a project and a script to mean anything. In demo/standalone
   *  there is no `project` object at all, but the mock still answers
   *  breakdown.run (honestly: `demo-inert`), so only the real path gates on it.
   *
   *  NOTE: an existing board is NOT a disabled reason. It used to be a hard
   *  refusal (`cells-exist`) the button never checked for, so "Scaffold shots"
   *  rendered enabled on a project where the verb provably refused (defect #2).
   *  Under D-8 that case is the retag path — a real thing the button does — so
   *  the fix is the label, not a gate. */
  const ctaDisabledReason =
    hasRealCells && !project ? 'no project open'
      : !scriptExists ? 'no script.fountain in this project yet'
        : !scriptText.trim() ? 'this script.fountain is empty'
          : actionBlocks.length === 0 ? 'no action paragraphs in this script'
            : null;

  /** The request we hand the Chi — BRANCHED ON BOARD STATE, because the skill
   *  itself branches on board state and a prompt that ignores that is real,
   *  unrecoverable data damage.
   *
   *  The skill's rule: empty board → scaffold (segment + create + tag); board
   *  WITH cells → retag only, create/delete/reorder nothing. This prompt used
   *  to ask for "segment it into shots … then write the cells and the [[shot
   *  tags]]" UNCONDITIONALLY. On the real forge board that is the scaffold
   *  branch invoked against 6 existing cells: the skill mints 8 more from the 8
   *  action paragraphs, every one with a fresh uid, so nothing rejects them
   *  (`create_cell` only refuses a DUPLICATE uid) — a 14-shot board from one
   *  click on a button whose sub-label promised "shot type · prompt · anchors".
   *
   *  `ctaDisabledReason` deliberately does NOT gate on an existing board — that
   *  reasoning was for the Scaffold button under D-8, where an existing board is
   *  a real path (retag), not a refusal. The fix belongs in the prompt, which is
   *  the thing that was actually wrong. */
  const buildChiPrompt = (): string => {
    // Board state as the USER sees it. In real mode `shots` is a 1:1 map of
    // hydratedCells, so this is the same fact the skill will read from
    // `storyboard.list_cells` — we are not predicting, we are describing.
    if (shots.length === 0) {
      return [
        `Please run the studio-breakdown skill on the open Ikenga Studio project ("${title}").`,
        `Its script.fountain has ${actionBlocks.length} action paragraphs across ${scenes.length} scenes,`,
        'and its board has no shots yet — so this is the skill\'s scaffold branch:',
        'segment the script into shots, create one cell per shot, infer each shot type and camera move,',
        'draft a generation prompt, extract the recurring characters, locations, props and style as anchors,',
        'and write each new cell\'s [[uid]] back onto the paragraph it came from as a Fountain note.',
        'Leave everything at rung 0 and do not render anything.',
      ].join(' ');
    }
    const uids = shots.map((s) => s.uid).join(', ');
    const untagged = untaggedShotUids.length > 0
      ? ` The shots still without a tag are: ${untaggedShotUids.join(', ')}.`
      : '';
    return [
      `Please run the studio-breakdown skill's RETAG branch on the open Ikenga Studio project ("${title}").`,
      `The board already has ${shots.length} shots (${uids}), so do not create, delete or reorder cells —`,
      'tag only.',
      `Read script.fountain (${actionBlocks.length} action paragraphs across ${scenes.length} scenes),`,
      'decide which paragraph describes which existing shot, and write only that shot\'s [[uid]] onto the',
      'paragraph as a Fountain note.' + untagged,
      'Leave any paragraph or shot you cannot confidently match untagged rather than stretching to make the',
      'counts come out even, and tell me which ones you left alone. Do not render anything.',
    ].join(' ');
  };

  const runBreakdown = async () => {
    if (ctaDisabledReason || busy) return;
    setBusy('run');
    setNotice(null);
    try {
      const client = await getMcpClient();
      // No project id — real-mcp injects the active project.
      const res = await breakdownApi.run(client);
      // The store carries the cells; the script text does not — it is this
      // view's own fetch. Both have to be re-read or the pane lies about what
      // just happened (no new shots, no new tags).
      await refetchStoryboard();
      setFountainNonce((n) => n + 1);

      const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
      // `tagged` is a LIST — its length is measured. There is no "tags written"
      // number to invent, and an empty list says so out loud.
      const tags = (n: number) => (n > 0 ? plural(n, 'tag', 'tags') + ' written into the script' : 'no tags written');
      // Only ever rendered when a write really happened AND the sidecar
      // reported a size. `null` means nothing was written — no number exists.
      const bytes = res.script_written && res.script_bytes != null ? ` (${res.script_bytes} bytes)` : '';

      // SWITCH ON `outcome`. A resolved promise does not mean the board changed.
      switch (res.outcome) {
        case 'demo-inert':
          // The mock cannot read or write a script that only exists as a JS
          // template literal, so it reports exactly that and every count is
          // null. Render its message; there is deliberately nothing numeric
          // here to print (defect #3).
          setNotice({
            tone: 'info',
            text: res.message ?? 'Demo data — there is no project on disk, so there was nothing to run.',
          });
          break;
        case 'scaffolded':
          setNotice({
            tone: 'ok',
            text: `${plural(res.created.length, 'shot created', 'shots created')} · ${tags(res.tagged.length)}${bytes}. `
              + 'Scaffold only — shot type, prompt and anchors are still unset; send it to your Chi for those.',
          });
          break;
        case 'retagged':
          // `created: []` here is BY DESIGN (D-8) — an existing board is never
          // scaffolded onto — so this reports tags only and claims no creation.
          setNotice({
            tone: 'ok',
            text: `${tags(res.tagged.length)}${bytes} against the ${plural(res.skipped.length, 'shot', 'shots')} already on the board`
              + `${res.already_tagged.length > 0 ? ` · ${res.already_tagged.length} already carried the right tag` : ''}. `
              + 'Nothing was created.',
          });
          break;
        case 'already-tagged':
          setNotice({
            tone: 'info',
            text: 'Every paragraph already carries the right tag — nothing to write.',
          });
          break;
        case 'ambiguous-needs-chi':
          // Matching is judgment and the verb refuses to guess. State the two
          // facts that made it a judgment and put the Chi one click away.
          setNotice({
            tone: 'info',
            text: res.ambiguous
              ? `${res.ambiguous.detail} (${res.ambiguous.paragraphs} action paragraphs vs ${res.ambiguous.cells} shots on the board.) `
                + 'Nothing was written — matching them is a judgment call.'
              : 'Which paragraph belongs to which shot is a judgment call here, so nothing was written.',
            // `buildChiPrompt` sees the same board this notice does — cells
            // exist (that is what made the match ambiguous), so it asks for the
            // retag branch. Nothing here can request a scaffold onto them.
            action: { label: 'Send to your Chi', run: () => void dispatchToChi() },
          });
          break;
        case 'script-write-failed':
          setNotice({
            tone: 'error',
            text: `Couldn't write script.fountain: ${res.script_error ?? 'no reason reported'}.`
              + (res.created.length > 0
                ? ` ${plural(res.created.length, 'shot was', 'shots were')} created before the write failed — the board and the script are now out of step.`
                : ''),
          });
          break;
        case 'planned':
          setNotice({
            tone: 'info',
            text: `Dry run — nothing was written. Would create ${res.would_create?.length ?? 0} and tag ${res.would_tag?.length ?? 0}.`,
          });
          break;
        default:
          // Forward-compat: a new outcome we don't know how to narrate. Say
          // that, rather than assuming it succeeded.
          setNotice({ tone: 'info', text: `Breakdown returned an outcome this pane doesn't recognise: ${res.outcome}.` });
          break;
      }
    } catch (err) {
      // Genuine errors (no-script / no-action-paragraphs / invalid-args) still
      // throw. The sidecar's message is already a complete, user-ready
      // sentence — surface it verbatim rather than rewriting it into
      // something vaguer.
      setNotice({ tone: 'error', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const dispatchToChi = async () => {
    if (ctaDisabledReason || busy) return;
    setBusy('chi');
    setNotice(null);
    const res = await sendToChi(buildChiPrompt(), 'studio:breakdown');
    setBusy(null);
    if (res.ok) {
      // `ok` means the REQUEST reached a session — nothing more. The procedure
      // lives in the studio-breakdown skill, a separately published package
      // this pane deliberately does not duplicate, so we cannot know whether
      // the Chi on the other end even has it. Promising the tags will be
      // written would be a fabrication about work that hasn't happened. Say
      // what we know: the request was sent, the answer is in the chat pane.
      setNotice({
        tone: 'ok',
        text: shots.length === 0
          ? 'Asked your Chi to break this script down — watch the chat pane. If it doesn\'t have the '
            + 'studio-breakdown skill it will say so there. This pane re-reads the script when the project '
            + 'reports a change; if it looks stale, use "Re-read script".'
          : 'Asked your Chi to tag this script against the board — watch the chat pane. If it doesn\'t have the '
            + 'studio-breakdown skill it will say so there. This pane re-reads the script when the project '
            + 'reports a change; if it looks stale, use "Re-read script".',
      });
      return;
    }
    // Never a silent no-op: name what actually refused and what to do about it.
    // Each of these blames the thing that really refused — see below on why
    // that distinction is not pedantry.
    if (res.reason === 'scope-denied') {
      // NOT the Chi refusing. This is the SHELL's own
      // `pkgDeclaresScope('engine','invoke')` check, which fires before the
      // request is ever routed to a session — the Chi never saw it and refused
      // nothing (defect #8). Blaming the Chi here sent users to argue with
      // their assistant about a manifest they needed to update.
      setNotice({
        tone: 'error',
        text: 'Studio isn\'t allowed to start a session, so the shell blocked this before your Chi ever saw it. '
          + 'The pkg\'s manifest needs permissions.engine: ["invoke"] — update or reinstall Studio to pick up that scope.',
      });
    } else if (res.reason === 'no-active-session') {
      setNotice({
        tone: 'error',
        text: 'No chat pane is focused, so there is no session to send to. Open your Chi in a pane, then try again.',
      });
    } else if (res.reason === 'no-host') {
      // Standalone dev: there is no shell, so there are no panes at all. Do
      // not tell the user to focus a chat pane that cannot exist (defect #9).
      setNotice({
        tone: 'error',
        text: 'This pane is running standalone, outside the Ikenga shell — there is no Chi to send to. '
          + 'Open Studio in the shell to hand this off.',
      });
    } else {
      setNotice({ tone: 'error', text: `Couldn't reach your Chi: ${res.reason}` });
    }
  };

  // ── gates ── (standalone/mock has no `project` object at all — those gates
  // only apply once we know we're in a real, hydrated session)
  if (hasRealCells && !project) {
    return (
      <EmptyState glyph="✂" title="No project open" hint="open a project to run its breakdown">
        <p className="mt-1 max-w-xs text-[11px] leading-relaxed text-fg-faint">
          Breakdown reads a project's script.fountain and its extracted shots — open one from the Launcher first.
        </p>
      </EmptyState>
    );
  }

  if (hasRealCells && fountain.loaded && !fountain.exists) {
    return (
      <EmptyState glyph="✂" title="Breakdown needs a script" hint="no script.fountain in this project">
        <p className="mt-1 max-w-xs text-[11px] leading-relaxed text-fg-faint">
          Breakdown links a `.fountain` screenplay to shots. Ask your Chi to draft a screenplay for this project (or drop a <span className="font-mono text-fg-muted">script.fountain</span> into the project folder), then the shot-by-shot breakdown appears here.
        </p>
      </EmptyState>
    );
  }

  if (hasRealCells && (fountain.loading || !fountain.loaded)) {
    return (
      <div className="flex h-full items-center justify-center bg-base">
        <p className="font-mono text-[11px] text-fg-faint">Loading screenplay…</p>
      </div>
    );
  }

  if (hasRealCells && fountain.error) {
    return (
      <EmptyState glyph="⚠" title="Couldn't read the screenplay" hint={fountain.error} />
    );
  }

  if (hasRealCells && !scriptExists) {
    return (
      <EmptyState glyph="✍" title="No script.fountain yet" hint="ask your Chi to draft one">
        <p className="mt-1 max-w-xs text-[11px] leading-relaxed text-fg-faint">
          Once a screenplay exists on disk, Breakdown will parse it into scenes on the left and line it up against the shots on the right.
        </p>
      </EmptyState>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-base text-fg">
      {/* ── header ── */}
      <div className="flex flex-none items-center justify-between gap-4 border-b border-soft bg-surface px-6 py-3">
        <div className="flex items-baseline gap-4">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-fg-faint">Breakdown</div>
            <h1 className="font-display text-lg font-medium">{title}</h1>
          </div>
          <div className="flex items-center gap-3 font-mono text-[11px] text-fg-muted">
            {!hasRealCells && (
              <span className="rounded border border-soft bg-raised px-1.5 py-0.5 text-[9.5px] uppercase tracking-wider text-fg-faint">
                Demo data
              </span>
            )}
            <span className="text-fg-faint">·</span>
            <span>{scriptFilename}</span>
            <span className="text-fg-faint">·</span>
            <span><span className="tabular-nums text-fg">{shots.length}</span> shots detected</span>
            <span className="text-fg-faint">·</span>
            <span><span className="tabular-nums text-fg">{anchors.length}</span> anchors extracted</span>
          </div>
        </div>

        {/* Two affordances, two honest halves (D-2): the mechanical scaffold
            and the judgment handoff. Neither pretends to do the other's job. */}
        <div className="flex flex-none items-stretch gap-2">
          <button
            type="button"
            onClick={() => void runBreakdown()}
            disabled={!!ctaDisabledReason || busy !== null}
            title={ctaDisabledReason
              ? `Unavailable — ${ctaDisabledReason}`
              : verbMode === 'retag'
                ? 'This board already has shots, so a run TAGS only: each action paragraph gets the [[tag]] of the shot it belongs to, written back into script.fountain. Nothing is created, nothing is rendered, nothing is spent. If which paragraph belongs to which shot is a judgment call, it stops and hands off to your Chi rather than guessing.'
                : verbMode === 'scaffold'
                  ? 'Deterministic: one cell per action paragraph + shot tags written back into script.fountain. No renders, no anchors, nothing spent.'
                  : 'Demo data — there is no project on disk, so there is no script to read or tag. This run is inert.'}
            className="flex items-center gap-3 rounded border px-4 py-2.5 text-left transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              borderColor: 'color-mix(in oklab, var(--agent) 55%, var(--border))',
              background: 'linear-gradient(180deg, color-mix(in oklab, var(--agent) 28%, var(--bg-raised)), color-mix(in oklab, var(--agent) 18%, var(--bg-sunken)))',
              color: 'color-mix(in oklab, var(--agent) 70%, var(--fg))',
            }}
          >
            <span className="flex h-[18px] w-[18px] items-center justify-center text-sm" style={{ color: 'var(--agent)' }}>◆</span>
            <span className="flex flex-col items-start gap-0.5">
              {/* The label names what the verb will ACTUALLY do to THIS board
                  (D-8): an existing board is retagged, never scaffolded onto. */}
              <span className="text-[12.5px] font-semibold">
                {busy === 'run'
                  ? (verbMode === 'retag' ? 'Tagging…' : 'Scaffolding…')
                  : verbMode === 'retag' ? 'Tag shots' : 'Scaffold shots'}
              </span>
              <span className="font-mono text-[10px]" style={{ color: 'color-mix(in oklab, var(--agent) 55%, var(--fg-muted))' }}>
                {ctaDisabledReason
                  ?? (verbMode === 'retag'
                    ? 'tags only · nothing created'
                    : verbMode === 'scaffold' ? 'cells + tags · no spend' : 'demo data · inert')}
              </span>
            </span>
          </button>

          <button
            type="button"
            onClick={() => void dispatchToChi()}
            disabled={!!ctaDisabledReason || busy !== null}
            title={ctaDisabledReason
              ? `Unavailable — ${ctaDisabledReason}`
              // Describes the branch this board will actually get. The skill
              // decides scaffold-vs-retag from the board, so a title promising
              // "shot type, camera, prompt and anchors" on a board that can only
              // be retagged is a promise the skill will refuse to keep.
              : shots.length === 0
                ? 'Asks your Chi to run the studio-breakdown skill on this empty board: segment the script into shots, '
                  + 'infer shot type / camera / prompt, extract anchors, and tag the script. Nothing is rendered. '
                  + 'It is a request — if your Chi doesn\'t have the skill, it will say so in the chat pane.'
                : `This board already has ${shots.length} shots, so this asks your Chi to TAG only — match each `
                  + 'paragraph to the shot it describes and write that shot\'s [[uid]] into the script. It is told '
                  + 'not to create, delete or reorder cells, and not to render. It is a request — if your Chi '
                  + 'doesn\'t have the studio-breakdown skill, it will say so in the chat pane.'}
            className="flex items-center gap-3 rounded border border-soft bg-raised px-4 py-2.5 text-left text-fg transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="flex h-[18px] w-[18px] items-center justify-center text-sm text-fg-muted">✦</span>
            <span className="flex flex-col items-start gap-0.5">
              <span className="text-[12.5px] font-semibold">
                {busy === 'chi' ? 'Sending…' : 'Send to your Chi'}
              </span>
              {/* "shot type · prompt · anchors" was a flat promise. On a board
                  with cells the skill's retag branch creates nothing and infers
                  nothing — it only writes tags. Name the half that will run. */}
              <span className="font-mono text-[10px] text-fg-faint">
                {ctaDisabledReason
                  ?? (shots.length === 0 ? 'shots · shot type · prompt · anchors' : 'tags only · nothing created')}
              </span>
            </span>
          </button>
        </div>
      </div>

      {/* ── facts strip — counts + the Track split. No money (D-4): no live
             pricing exists on the wire, so any figure here would be fiction.
             Nothing here may promise what a run will do — it states what IS. ── */}
      <div className="flex-none border-b border-soft bg-sunken px-6 py-2 font-mono text-[10.5px] text-fg-muted">
        {/* This used to promise "(existing shots are skipped, no anchors)" —
            a fabrication: nothing was skipped, the whole run refused. Under
            D-8 the honest line depends on which half will actually run.
            `verbMode` is NULL in demo, and this ternary used to key on
            `=== 'retag'`, so standalone fell through to the SCAFFOLD copy —
            promising "one cell per action paragraph" for a run that provably
            returns `demo-inert` and creates nothing. Demo gets its own branch;
            it is not a flavour of scaffold. */}
        {verbMode === null ? (
          <>
            Demo data — there is no project on disk, so a run has nothing to read, create or tag:{' '}
            <span className="tabular-nums text-fg">{actionBlocks.length}</span> action paragraphs in this
            {' '}demo script
          </>
        ) : verbMode === 'retag' ? (
          <>
            Board already has shots — a run tags paragraphs against them, creating nothing:{' '}
            <span className="tabular-nums text-fg">{actionBlocks.length}</span> action paragraphs vs{' '}
            <span className="tabular-nums text-fg">{shots.length}</span> shots
          </>
        ) : (
          <>
            Scaffold proposes one cell per action paragraph —{' '}
            <span className="tabular-nums text-fg">{actionBlocks.length}</span> in this script
            {' '}(shot type, prompt and anchors stay unset)
          </>
        )}
        <span className="text-fg-faint"> · </span>
        board: <span className="tabular-nums text-fg">{shots.length}</span> shots
        {/* Track is an estimate off the engine capability matrix — so when the
            matrix isn't loaded there is no estimate to state, only that fact. */}
        {noTrackMatrix ? (
          <span className="text-fg-faint"> · track unknown (engine list unavailable)</span>
        ) : (
          <>
            {' · '}Track A <span className="tabular-nums text-fg">{trackACount}</span>
            {' / '}Track B <span className="tabular-nums text-fg">{trackBCount}</span>
            {trackUnknownCount > 0 && (
              <>{' / unknown '}<span className="tabular-nums text-fg">{trackUnknownCount}</span></>
            )}
            {/* "(estimate)" implies something was estimated FROM something. In
                demo nothing was: no matrix is fetched and these are literals on
                DEMO_SHOTS. Name the real source (defect #11, demo codepath). */}
            <span className="text-fg-faint"> {hasRealCells ? '(estimate)' : '(demo fixture)'}</span>
          </>
        )}
        <span className="text-fg-faint"> · </span>
        anchors: <span className="tabular-nums text-fg">{anchors.length - pendingAnchors}</span>
        {' of '}<span className="tabular-nums text-fg">{anchors.length}</span> ready
        <span className="text-fg-faint"> · {railNote}</span>
      </div>

      {/* Result of the last CTA — success, refusal and "nothing happened" are
          equally loud. `info` carries its own accent so an inert or handed-off
          result never wears the success colour. */}
      {notice && (
        <div
          className="flex flex-none items-center gap-3 border-b border-soft px-6 py-2 font-mono text-[10.5px]"
          style={{
            background: 'var(--bg-sunken)',
            color: notice.tone === 'error' ? 'var(--fg)' : 'var(--fg-muted)',
            borderLeft: `2px solid ${notice.tone === 'error'
              ? 'var(--danger)'
              : notice.tone === 'info' ? 'var(--border)' : 'var(--agent)'}`,
          }}
          role="status"
        >
          <span className="min-w-0 flex-1">{notice.text}</span>
          {notice.action && (
            <button
              type="button"
              onClick={notice.action.run}
              disabled={busy !== null}
              className="flex-none rounded border border-soft bg-raised px-2 py-1 text-[10px] text-fg transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {notice.action.label}
            </button>
          )}
        </div>
      )}

      {/* ── 4-zone body ── */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.3fr)_auto_minmax(0,1.6fr)_minmax(0,1fr)] gap-0 overflow-hidden px-6 py-4">

        {/* SCRIPT */}
        <div className="flex min-h-0 flex-col pr-5">
          <div className="mb-3 flex items-center justify-between gap-2 border-b border-soft pb-2.5">
            <span className="font-mono text-[10px] uppercase tracking-widest text-fg-faint">Script</span>
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-mono text-[11px] text-fg-muted">{scriptFilename}</span>
              {/* Not redundant with the cells/changed subscription. That seam is
                  code-verified end to end but NOT live-verified, and it only
                  exists inside the shell — standalone has no parent window to
                  relay frames. An explicit control is the honest floor: it makes
                  no claim about push at all, and it is the thing to reach for
                  when an external write doesn't land on its own. */}
              {hasRealCells && (
                <button
                  type="button"
                  onClick={rereadScript}
                  disabled={fountain.loading}
                  title="Re-read script.fountain and the board from disk. This pane also re-reads on its own when the project reports a change — use this if an outside edit (your Chi, an editor) hasn't shown up here."
                  className="flex-none rounded border border-soft bg-raised px-1.5 py-0.5 font-mono text-[9.5px] text-fg-faint transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {fountain.loading ? 'Reading…' : '↻ Re-read script'}
                </button>
              )}
            </div>
          </div>
          <div ref={scriptScrollRef} className="min-h-0 flex-1 overflow-y-auto pr-1.5">
            {/* Title card (D-5) — the script's authored title page, as its own
                element. Keys are verbatim from the source, so nothing is
                assumed to exist; Title (if present) leads, the rest follow in
                source order as mono micro-label / value rows. */}
            {titleCard && (
              <div className="mb-5 rounded border border-soft bg-surface px-3.5 py-3">
                <div className="font-mono text-[9px] uppercase tracking-widest text-fg-faint">Title page</div>
                {titleCard.title && (
                  <h2 className="mt-1.5 font-display text-[17px] font-medium leading-tight text-fg">
                    {titleCard.title}
                  </h2>
                )}
                {titleCard.rest.length > 0 && (
                  <dl className="mt-2.5 flex flex-col gap-1 border-t border-soft pt-2.5">
                    {titleCard.rest.map(([k, v]) => (
                      <div key={k} className="flex gap-2.5">
                        <dt className="w-[76px] flex-none font-mono text-[9px] uppercase tracking-wider text-fg-faint">
                          {k}
                        </dt>
                        <dd className="min-w-0 flex-1 text-[11px] leading-snug text-fg-muted">{v}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            )}
            {scenes.map((scene, sceneIdx) => {
              return (
                <div key={scene.id}>
                  <div className="mb-4 border-b border-dashed border-soft pb-3.5 pt-2.5 font-mono text-[11.5px] uppercase tracking-wider text-fg-muted">
                    {scene.heading}
                  </div>
                  {scene.blocks
                    .filter((b) => b.kind === 'action')
                    .map((blk, i) => {
                      const globalIdx = sceneActionOffsets[sceneIdx] + i;
                      const linkId = linking.paraLink[globalIdx];
                      const isActive = !!linkId && linkId === activeId;
                      return (
                        <p
                          key={i}
                          ref={(el) => {
                            if (!linkId) return;
                            if (el) paraRefs.current.set(linkId, el);
                            else paraRefs.current.delete(linkId);
                          }}
                          className="relative mb-1 rounded-sm border-l-2 px-3 py-2 font-mono text-[12.5px] leading-relaxed transition-colors"
                          style={{
                            borderLeftColor: isActive ? 'var(--agent)' : 'transparent',
                            background: isActive ? 'var(--bg-raised)' : undefined,
                            color: isActive ? 'var(--fg)' : 'var(--fg-muted)',
                          }}
                          onMouseEnter={() => linkId && setActiveId(linkId)}
                          onMouseLeave={() => setActiveId((cur) => (cur === linkId ? null : cur))}
                        >
                          {blk.text}
                          {/* The uid badge is only ever shown for a TAG link,
                              which is exact — it is the tag the script itself
                              carries, read back. It used to render in the
                              positional mode too, where it read as authoritative
                              while being known-wrong-by-one (defect #12); that
                              mode no longer exists (D-1a). */}
                          {linkId && (
                            <span className="ml-1.5 font-mono text-[9.5px]" style={{ color: isActive ? 'var(--agent)' : 'var(--fg-faint)' }}>
                              [[{linkId}]]
                            </span>
                          )}
                        </p>
                      );
                    })}
                </div>
              );
            })}
            {scenes.length === 0 && (
              <p className="p-2 font-mono text-[11px] text-fg-faint">No action lines parsed from this screenplay.</p>
            )}
          </div>
        </div>

        {/* RAIL — draws whatever the script's [[tags]] link, and nothing else
            (D-1a). Never suppressed because some paragraphs or shots are
            unlinked; an empty rail means this script carries no tags yet.
            That empty state is not a dead gutter — it offers the way out of
            itself, which is the only reason dropping the positional guess is
            acceptable: the Chi can write the tags, and then the rail is exact. */}
        <div className="relative flex w-11 shrink-0 flex-col">
          {linking.railIds.length > 0 && (
            <BreakdownRail
              activeId={activeId}
              paraRefs={paraRefs}
              shotRefs={shotRefs}
              railRef={railRef}
              scriptScrollRef={scriptScrollRef}
              shotScrollRef={shotScrollRef}
              ids={linking.railIds}
            />
          )}
          {/* Gated on tagging being INCOMPLETE, not on the rail being empty.
              This used to be the `else` of `railIds.length > 0`, so ANY nonzero
              match hid it — and a 5-of-6 rail is exactly what the skill produces
              when it honestly declines to guess one shot. That stranded the
              user: the only route left was the header CTA, whose default prompt
              was the cell-CREATING one. Overlaid rather than stacked so the rail
              keeps its full measured height. */}
          {tagIncomplete && !ctaDisabledReason && (
            <button
              type="button"
              onClick={() => void dispatchToChi()}
              disabled={busy !== null}
              title={linkedShotCount === 0
                ? 'Nothing links these two columns yet: this script carries no [[shot tags]], and we won\'t guess — '
                  + 'matching by position was wrong by one on real scripts. Ask your Chi to read the script against '
                  + 'the board and write the tags; then this rail is exact. It creates no shots.'
                : `${linkedShotCount} of ${shots.length} shots are tagged — ${untaggedShotUids.join(', ')} `
                  + 'still have no line, so no paragraph on the left claims them. Ask your Chi to place the rest. '
                  + 'It tags only: nothing is created, deleted or reordered.'}
              className="absolute left-1/2 top-2 z-10 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded border border-soft bg-raised text-[12px] text-fg-faint shadow-sm transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={linkedShotCount === 0
                ? 'Ask your Chi to tag this script'
                : `Ask your Chi to tag the remaining ${shots.length - linkedShotCount} of ${shots.length} shots`}
            >
              ✦
            </button>
          )}
        </div>

        {/* SHOTS / BOARD */}
        <div className="flex min-h-0 flex-col border-x border-soft px-5">
          <div className="mb-3 flex items-center justify-between border-b border-soft pb-2.5">
            <span className="font-mono text-[10px] uppercase tracking-widest text-fg-faint">Board — {shots.length} shots</span>
            <span className="font-mono text-[10.5px] text-fg-muted">
              {shots[0]?.shotId ?? '—'} → {shots[shots.length - 1]?.shotId ?? '—'}
            </span>
          </div>
          <div ref={shotScrollRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
            {shots.map((shot, i) => {
              const linkId = linking.shotLink[i];
              const isActive = !!linkId && linkId === activeId;
              return (
                <div
                  key={shot.uid}
                  ref={(el) => {
                    if (!linkId) return;
                    if (el) shotRefs.current.set(linkId, el);
                    else shotRefs.current.delete(linkId);
                  }}
                  className="grid grid-cols-[70px_1fr] gap-3.5 rounded border p-2.5 transition-colors"
                  style={{
                    borderColor: isActive ? 'var(--agent)' : 'var(--border-soft)',
                    background: isActive ? 'var(--bg-raised)' : 'var(--bg-surface)',
                  }}
                  onMouseEnter={() => linkId && setActiveId(linkId)}
                  onMouseLeave={() => setActiveId((cur) => (cur === linkId ? null : cur))}
                >
                  {/* Thumb — the real rendered frame when this shot has a done
                      render (same poster seam as Canvas), else the ember glow
                      (concept .shot-thumb): warm key rising from the lower-left
                      over bg-sunken, not a flat well. The shot-type label always
                      sits on top. */}
                  <div
                    className="relative flex h-14 items-end justify-start overflow-hidden rounded-sm border border-soft p-1"
                    style={{
                      background: 'radial-gradient(120% 140% at 18% 100%, hsl(20,55%,20%) 0%, transparent 60%), var(--bg-sunken)',
                    }}
                  >
                    {shot.record?.id && (
                      <CellPoster
                        recordId={shot.record.id}
                        alt={shot.shotId}
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                    )}
                    <span className="relative font-mono text-[9px] tracking-wider text-fg-faint">{shot.shotType.toUpperCase()}</span>
                  </div>
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2 font-mono text-[10.5px] text-fg-muted">
                      <span className="font-medium text-fg">{shot.shotId}</span>
                      <span className="text-fg-faint">·</span>
                      <span className="rounded border border-soft px-1.5 py-0.5 text-[9.5px] text-fg-muted">{shot.shotType.toUpperCase()}</span>
                      {/* Engine chip only when something really FINISHED for
                          this shot (`record` is done-only — see the projection
                          above); the labelled Track estimate when nothing has
                          (D-3). */}
                      {shot.record ? (
                        <span
                          className="ml-auto flex items-center gap-1 rounded border border-soft bg-sunken px-1.5 py-0.5 text-[9.5px] tracking-wider text-fg-muted"
                          title={`Engine that rendered this shot: ${shot.record.engine}${shot.record.model_id ? ` · model ${shot.record.model_id}` : ''} (from its completed render record)`}
                        >
                          <span className="text-fg">{engineLabel(shot.record.engine)}</span>
                          {shot.record.model_id && (
                            <>
                              <span className="text-fg-faint">▸</span>
                              <span>{shortModelId(shot.record.model_id)}</span>
                            </>
                          )}
                        </span>
                      ) : (
                        <span
                          className="ml-auto flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider"
                          style={{
                            color: shot.track === 'A' ? 'var(--agent)' : 'var(--fg-faint)',
                            background: shot.track === 'A' ? 'var(--agent-soft)' : 'var(--bg-sunken)',
                          }}
                          title={
                            // Only a REAL shot whose track came out of
                            // `trackForCell` may cite the matrix. Demo shots
                            // never touch it — their track is a hardcoded
                            // literal on DEMO_SHOTS and no matrix is ever
                            // fetched in demo mode (the engines effect
                            // early-returns) — so citing one here is the exact
                            // fabrication the `unknown` state was added to
                            // prevent, surviving on the other codepath (#11).
                            !hasRealCells
                              ? `Demo data — Track ${shot.track} is a fixed value in the demo fixture. Nothing was estimated and no engine capability matrix was fetched.`
                              // The first two cite the matrix; the third IS the
                              // absence of it.
                              : shot.track === 'A'
                                ? 'Estimate — nothing has rendered for this shot yet. Guessed Track A (fal, in-app) from the engine capability matrix, not from a stored field.'
                                : shot.track === 'B'
                                  ? 'Estimate — nothing has rendered for this shot yet. Guessed Track B (handoff to an external tool) from the engine capability matrix, not from a stored field.'
                                  : enginesFailed
                                    ? 'Unknown — nothing has rendered for this shot, and the engine list could not be loaded, so there is no capability matrix to estimate a track from.'
                                    : 'Unknown — nothing has rendered for this shot, and the engine list has not loaded yet, so there is no capability matrix to estimate a track from.'
                          }
                        >
                          {shot.track === 'unknown' ? 'Track ?' : `Track ${shot.track}`}
                        </span>
                      )}
                    </div>
                    {/* Real action text is long — it wraps (concept: 12.5px/1.4)
                        rather than ellipsising every card into uselessness. */}
                    <div className="break-words text-[12.5px] leading-[1.4] text-fg">{shot.action}</div>
                    <div className="flex flex-wrap gap-1">
                      {shot.anchorIds.length === 0 && (
                        <span className="font-mono text-[9.5px] text-fg-faint">no anchors</span>
                      )}
                      {shot.anchorIds.map((id) => (
                        <span key={id} className="rounded-sm border border-soft bg-sunken px-1.5 py-0.5 font-mono text-[9.5px] text-fg-muted">
                          {anchors.find((a) => a.id === id)?.name ?? id}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
            {shots.length === 0 && (
              <EmptyState glyph="🎬" title="No shots yet" hint="run breakdown to extract them from the script" className="flex flex-1 flex-col items-center justify-center gap-2 text-center" />
            )}
          </div>
        </div>

        {/* ANCHORS */}
        <div className="flex min-h-0 flex-col pl-5">
          <div className="mb-3 flex items-center justify-between border-b border-soft pb-2.5">
            <span className="font-mono text-[10px] uppercase tracking-widest text-fg-faint">Extracted anchors</span>
            <span className="font-mono text-[10.5px] text-fg-muted">{anchors.length - pendingAnchors} ready</span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            {anchorsError && (
              <p className="font-mono text-[10.5px] text-fg-faint">Couldn't load anchors: {anchorsError}</p>
            )}
            {anchors.map((a) => {
              const meta = anchorMeta(a);
              const ready = !!a.asset?.uri;
              const isStyle = a.kind === 'style';
              return (
                <div
                  key={a.id}
                  className="flex gap-2.5 rounded border p-2.5"
                  style={{
                    borderColor: 'var(--border-soft)',
                    background: isStyle ? 'var(--bg-sunken)' : 'var(--bg-surface)',
                  }}
                >
                  {!isStyle && (
                    <div
                      className="mt-px flex h-4 w-4 flex-none items-center justify-center rounded-[3px] border text-[10px]"
                      style={{
                        borderColor: ready ? 'var(--live)' : 'var(--border)',
                        background: ready ? 'var(--live-soft)' : 'transparent',
                        color: ready ? 'var(--live)' : 'var(--fg-faint)',
                      }}
                    >
                      {ready ? '✓' : ''}
                    </div>
                  )}
                  {isStyle && <span className="mt-px text-[12px]" style={{ color: 'var(--achievement)' }}>◆</span>}
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex items-baseline gap-1.5">
                      <span className="font-display text-[13.5px] font-medium" style={{ color: isStyle ? 'var(--achievement)' : undefined }}>
                        {a.name}
                      </span>
                      <span className="font-mono text-[9px] uppercase tracking-wider text-fg-faint">
                        {isStyle ? 'Style · locked' : a.kind}
                      </span>
                    </div>
                    {meta.description && (
                      <p className="text-[11px] leading-snug text-fg-muted">{meta.description}</p>
                    )}
                    <div className="mt-0.5 flex gap-2.5 font-mono text-[9.5px] text-fg-faint">
                      <span>{meta.seed != null ? <>seed <span className="tabular-nums text-fg-muted">{meta.seed}</span></> : 'no seed yet'}</span>
                      {!isStyle && <span>used in <span className="tabular-nums text-fg-muted">{anchorUsage.get(a.id) ?? 0}</span> shots</span>}
                    </div>
                  </div>
                </div>
              );
            })}
            {anchors.length === 0 && !anchorsError && (
              <EmptyState glyph="◆" title="No anchors yet" hint="run breakdown to extract them" className="flex flex-1 flex-col items-center justify-center gap-2 text-center" />
            )}
          </div>

          <div className="flex-none space-y-1.5 border-t border-soft pt-3.5">
            <div className="flex justify-between font-mono text-[10.5px] text-fg-muted">
              <span>Anchors ready</span>
              <span className="tabular-nums text-fg">{anchors.length - pendingAnchors} / {anchors.length}</span>
            </div>
            {/* Same rule as the pill: with no capability matrix there is no
                A/B split to report, and printing "Track B — 6 shots" would be
                indistinguishable from a real finding (#11). */}
            {noTrackMatrix ? (
              <div className="flex justify-between font-mono text-[10.5px] text-fg-muted">
                <span>Track split</span>
                <span className="text-fg-faint">unknown — no engine list</span>
              </div>
            ) : (
              <>
                {/* Demo splits are counted off fixture literals, not estimated
                    off a matrix. Label the source rather than let the heading
                    imply one (#11, demo codepath). */}
                {!hasRealCells && (
                  <div className="flex justify-between font-mono text-[10.5px] text-fg-muted">
                    <span>Track split</span>
                    <span className="text-fg-faint">demo fixture — not estimated</span>
                  </div>
                )}
                <div className="flex justify-between font-mono text-[10.5px] text-fg-muted">
                  <span>Track A (fal, this app)</span>
                  <span className="tabular-nums text-fg">{trackACount} shots</span>
                </div>
                <div className="flex justify-between font-mono text-[10.5px] text-fg-muted">
                  <span>Track B (handoff)</span>
                  <span className="tabular-nums text-fg">{trackBCount} shots</span>
                </div>
                {trackUnknownCount > 0 && (
                  <div className="flex justify-between font-mono text-[10.5px] text-fg-muted">
                    <span>Track unknown</span>
                    <span className="tabular-nums text-fg">{trackUnknownCount} shots</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
