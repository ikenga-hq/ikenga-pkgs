/**
 * Per-project FS watcher with a 250ms debounce window.
 *
 * Watches under `<projectRoot>/`:
 *   • storyboard.json
 *   • script.{json,fountain}
 *   • cells/**
 *   • anchors/**
 *   • blocks/**
 *   • archetypes/**
 *
 * Excludes: renders/**, exports/**, node_modules/**, .git/**.
 *
 * Within a 250ms window we coalesce events to one notification per
 * (cellId, kind) pair. This mirrors the Rust `notify-debouncer-mini` shape
 * described in `plans/studio/01-plan.md` §250ms; chokidar's
 * `awaitWriteFinish` plus a small debounce wrapper is the node analogue.
 *
 * Implementation note: chokidar is `require`-ed dynamically and marked
 * external in the bundle. That avoids a hard typecheck dep and lets us
 * keep the node_modules resolution at runtime.
 *
 * Windows note (found while adding G-48's headless watcher test): chokidar
 * glob-suffixed targets (`cells/**`) matched ZERO fs events on win32 in
 * manual testing — chokidar's own docs call glob-based watching unreliable
 * on Windows, and here it silently dropped every event rather than
 * erroring. Worse: once switched to plain directory paths, handing
 * `chokidar.watch()` an array that includes even ONE path that doesn't yet
 * exist (e.g. a fresh project with no `anchors/` or `script.fountain`) was
 * enough to silently kill event delivery for every OTHER target in that
 * same call too — not just the missing one. Below we resolve `WATCH_GLOBS`
 * to plain paths (directories watch recursively by default, so the `/**`
 * suffix is redundant) and pass chokidar only the ones that exist at watch
 * start; the rest are skipped with a stderr note rather than poisoning the
 * whole group. Known trade-off: a target that doesn't exist yet (e.g. no
 * `.studio/` until the first Chi note) won't start emitting the moment it's
 * first created — only `storyboard.json` and `cells/` are load-bearing
 * enough to matter for the common case (G-48; any project that opens at all
 * already has both), and a full fix (re-`watcher.add()` a target lazily
 * once its parent shows up) is bigger than this closer's scope.
 */

import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';

import {
  emitCellsChanged,
  type EventWriter,
  type CellsChangedPayload,
} from './events.js';

export interface WatcherOptions {
  /**
   * Debounce window in ms — defaults to 50. The G18 contract caps total
   * touch→emit latency at 250ms; coalescing burst writes within 50ms gives
   * us comfortable headroom over chokidar's event-loop overhead while
   * still merging the typical "atomic write" sequence
   * (`tmp` → `rename` → `chmod`) into one notification.
   */
  debounceMs?: number;
  /** Override the event writer (default: stdout). */
  writer?: EventWriter;
  /**
   * Called once per flush in which `storyboard.json` itself changed, BEFORE
   * the `cells/changed` notifications for that flush go out.
   *
   * WP-32 live-found (g58): the project document is a first-class input —
   * an agent, the CLI, or a human with an editor can rewrite it out of band
   * (WP-26). Every FS-going reader (the whole FE, via `storyboard.list_cells`)
   * then sees the new bytes, but the sidecar's in-memory open-project record
   * was only ever refreshed by the *mutating* RPCs, so the exporter and the
   * render runner — which read that cache — kept cutting the old document.
   * Live: a `Cell.index` rotation on disk re-ordered the lane within 3 s while
   * an export 2.5 min later used the pre-edit order, silently. This hook is
   * how index.ts re-hydrates the cache on an out-of-band edit; it fires before
   * the emit so a FE refetch triggered by the event can't observe a cache the
   * exporter hasn't caught up with.
   */
  onProjectDocChanged?: (absPath: string) => void;
}

export interface WatcherHandle {
  close(): Promise<void>;
  /** Latest emit timestamp for testing latency. */
  lastEmitTs(): number | null;
}

type ChangeKind = CellsChangedPayload['kind'];

interface PendingChange {
  cellId: string;
  kind: ChangeKind;
  path: string;
}

// Same shape as plans/studio/01-plan.md §"Sub-view refresh".
const WATCH_GLOBS = [
  'storyboard.json',
  'script.json',
  'script.fountain',
  'cells/**',
  'anchors/**',
  'blocks/**',
  'archetypes/**',
  // Plan 25 asks for `canvas.json`; we watch the whole `.studio/` directory
  // instead because chokidar is watching plain paths (see the header) and a
  // directory target also survives the file being created for the first time.
  // The canvas writer keeps its scratch file OUT of `.studio/` precisely so
  // this stays one emit per save — see canvas.ts.
  '.studio/**',
];

/**
 * `deriveCellId`'s synthetic id for the project document itself. The flush
 * loop matches on this to decide whether `onProjectDocChanged` fires.
 */
export const PROJECT_DOC_CELL_ID = 'project:storyboard.json';

const IGNORED = [
  '**/renders/**',
  '**/exports/**',
  '**/node_modules/**',
  '**/.git/**',
];

/**
 * Derive the cellId from a watcher path. For `cells/<rungDir>/<uid>/<file>`
 * the cellId is `<uid>`. For project-root files (`storyboard.json`,
 * `script.*`) or files outside `cells/`, we return a synthetic id so the
 * caller can still display the path.
 */
function deriveCellId(projectRoot: string, absPath: string): string {
  // Normalize the project root with a trailing sep so the relative slice
  // starts cleanly.
  const root = projectRoot.endsWith(sep) ? projectRoot : projectRoot + sep;
  const rel = absPath.startsWith(root) ? absPath.slice(root.length) : absPath;
  const parts = rel.split(sep);
  if (parts[0] === 'cells' && parts.length >= 3) {
    // cells/<rungDir>/<uid>/...
    return parts[2];
  }
  if (parts[0] === 'anchors' || parts[0] === 'blocks' || parts[0] === 'archetypes') {
    return `${parts[0]}:${parts[1] ?? ''}`;
  }
  if (parts.length === 1 && (parts[0] === 'storyboard.json' || parts[0].startsWith('script.'))) {
    return `project:${parts[0]}`;
  }
  return `path:${rel}`;
}

export async function startWatcher(
  projectId: string,
  projectRoot: string,
  opts: WatcherOptions = {},
): Promise<WatcherHandle> {
  const debounceMs = opts.debounceMs ?? 50;
  const writer = opts.writer ?? ((line: string) => process.stdout.write(line + '\n'));

  // Chokidar honours two global env vars that override constructor opts:
  // `CHOKIDAR_USEPOLLING` (forces stat-polling instead of inotify/fsevents)
  // and `CHOKIDAR_INTERVAL` (the poll period). In typical dev shells those
  // are set as a workaround for NFS / Docker-overlay filesystems and push
  // latency to 500-1000ms — well over the G18 250ms cap. The sidecar runs
  // against the user's local FS where inotify works, so we suppress both
  // for the duration of our `chokidar.watch()` constructor call and log
  // the override so devs aren't surprised when their global hack is
  // ignored here.
  const prevUsePolling = process.env.CHOKIDAR_USEPOLLING;
  const prevInterval = process.env.CHOKIDAR_INTERVAL;
  if (prevUsePolling !== undefined || prevInterval !== undefined) {
    process.stderr.write(
      `[studio-sidecar][watcher] suppressing CHOKIDAR_USEPOLLING=${prevUsePolling ?? ''}` +
        ` CHOKIDAR_INTERVAL=${prevInterval ?? ''} for this watcher (G18 latency contract)\n`,
    );
    delete process.env.CHOKIDAR_USEPOLLING;
    delete process.env.CHOKIDAR_INTERVAL;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chokMod: any = await import('chokidar');
  const chokidar = chokMod.default ?? chokMod;

  // Resolve WATCH_GLOBS against projectRoot as plain paths, NOT chokidar
  // globs (see the Windows note in the file header) — directories already
  // watch recursively by default, which is exactly what the trailing `/**`
  // was asking for, so we strip it and hand chokidar a plain path via
  // `join` (OS-native separators throughout, matching what `deriveCellId`
  // expects back). Then drop any target that doesn't exist yet: one missing
  // path in the array is enough to silently kill delivery for every OTHER
  // target too (see file header) — pruning is strictly safer than passing
  // it through and losing the whole watcher.
  const candidates = WATCH_GLOBS.map((g) => join(projectRoot, g.replace(/\/\*\*$/, '')));
  const targets = candidates.filter((t) => existsSync(t));
  const skipped = candidates.filter((t) => !existsSync(t));
  if (skipped.length > 0) {
    process.stderr.write(
      `[studio-sidecar][watcher] skipping ${skipped.length} not-yet-existing target(s) ` +
        `(will not be live until the project is reopened): ${skipped.join(', ')}\n`,
    );
  }

  // Note on `awaitWriteFinish`: useful for noisy editors that write in
  // chunks, but it adds at least one `stabilityThreshold` worth of latency
  // before the event fires. Our debounce window already coalesces burst
  // writes (and the Excalidraw atomic-save contract — write `.tmp` then
  // `rename()` — produces a single `add`/`change` event, not a chunked
  // write), so we keep awaitWriteFinish off to stay comfortably under the
  // 250ms G18 cap.
  const watcher = chokidar.watch(targets, {
    ignored: IGNORED,
    ignoreInitial: true,
    awaitWriteFinish: false,
    persistent: true,
    usePolling: false,
  });

  // Debounce buffer keyed by `cellId|kind` so repeated events for the
  // same logical change coalesce.
  const pending = new Map<string, PendingChange>();
  let flushTimer: NodeJS.Timeout | null = null;
  let lastEmit: number | null = null;

  const scheduleFlush = (): void => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const batch = Array.from(pending.values());
      pending.clear();
      // Cache coherence before notification (see onProjectDocChanged): if
      // storyboard.json moved, let the owner re-hydrate from disk first. A
      // throwing hook must not cost us the emits.
      const docChange = batch.find((c) => c.cellId === PROJECT_DOC_CELL_ID);
      if (docChange && opts.onProjectDocChanged) {
        try {
          opts.onProjectDocChanged(docChange.path);
        } catch (e) {
          process.stderr.write(
            `[studio-sidecar][watcher] onProjectDocChanged failed: ${(e as Error).message}\n`,
          );
        }
      }
      for (const change of batch) {
        emitCellsChanged(writer, projectId, change);
      }
      if (batch.length > 0) lastEmit = Date.now();
    }, debounceMs);
  };

  const onEvent = (kind: ChangeKind, absPath: string): void => {
    const cellId = deriveCellId(projectRoot, absPath);
    const key = `${cellId}|${kind}`;
    pending.set(key, { cellId, kind, path: absPath });
    scheduleFlush();
  };

  watcher.on('add', (p: string) => onEvent('created', p));
  watcher.on('change', (p: string) => onEvent('updated', p));
  watcher.on('unlink', (p: string) => onEvent('deleted', p));
  watcher.on('addDir', (p: string) => onEvent('created', p));
  watcher.on('unlinkDir', (p: string) => onEvent('deleted', p));
  watcher.on('error', (err: unknown) => {
    process.stderr.write(
      `[studio-sidecar][watcher][error] ${(err as Error).message}\n`,
    );
  });

  // Wait for chokidar's initial scan to complete before returning. Without
  // this, fresh writes immediately after `project.open` would race the
  // walker — chokidar wouldn't yet have an inotify watch on the cell's
  // parent directory, and the event would arrive only on the slower
  // polling fallback.
  await new Promise<void>((resolveReady) => {
    watcher.once('ready', () => resolveReady());
  });

  // Restore the env vars now that the watcher is configured — anything
  // else in this process that reads them later sees the original values.
  if (prevUsePolling !== undefined) process.env.CHOKIDAR_USEPOLLING = prevUsePolling;
  if (prevInterval !== undefined) process.env.CHOKIDAR_INTERVAL = prevInterval;

  return {
    async close() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      await watcher.close();
    },
    lastEmitTs() {
      return lastEmit;
    },
  };
}
