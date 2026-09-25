// com.ikenga.studio · Composition view — broadcast cockpit v2 (Wave-2 rebuild)
//
// Locked concept: composition-a-cockpit.html (C-A) with grafts —
//   • render-records truth surface + "Synced Ns ago" + Refresh  (C-C)
//   • export pre-flight dialog (focus trap + Esc) + explicit Empty preview  (C-B)
//   • real per-cell filmstrip titles                                        (C-B)
//
// Real playback (closes `composition-no-real-playback-ever`): the transport's
// rAF mock clock stays the TIMELINE authority (it sequences all N cells for the
// scrubber/ruler/filmstrip), while real pixels come from bytes-over-the-bridge —
// CellVideo previews the active done cell's mp4 (per-cell), and ComposedVideo
// plays the export mp4 (composed). Both degrade to the poster/status when bytes
// aren't available, never to a fake player. See views/composition/* + the
// playback-seam probe verdict for why file:// / loopback don't work in the pane.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  TransportBar,
  TimeRuler,
  ScrubberPlayhead,
  PlayheadEcho,
  PreviewSurface,
  PreviewStatus,
  type PreviewAspect,
} from '../media-controls';
import { createMockPlayer, type PlayerHandle } from '../lib/player';
import { DEFAULT_FPS, framesToMs, msToFrames, snapMsToFrame } from '../lib/time';
import {
  COMPOSITION_META,
  COMPOSITION_NARRATION,
  COMPOSITION_TIMELINE,
  COMPOSITION_TOTAL_MS,
  WAVEFORM_BARS,
  WAVEFORM_BAR_COUNT,
  type TimelineClip,
} from '../__mocks__/composition';
import { buildTimelineModel, clipAt, type TimelineModel } from '../lib/composition-model';
import {
  selectCellUid,
  selectEngineMode,
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
  selectLastSyncedAt,
} from '../storyboard-store';
import { getMcpClient, compositionApi, exportApi } from '../mcp-client';
import type { BedCheck } from '../mcp-client';
import type { Cell } from '../mcp-types';
import { pollRenderUntilDone, pollExportUntilDone } from '../lib/render-poll';
import { CellVideo, type CellVideoAvailability } from './composition/CellVideo';
import { CellPoster } from './composition/CellPoster';
import { ComposedVideo } from './composition/ComposedVideo';
import { ExportCard, type ExportUiState } from './composition/ExportCard';
import { ExportPreflightDialog } from './composition/ExportPreflightDialog';
import { RecordsPanel } from './composition/RecordsPanel';
import {
  fmtClock,
  fmtSeconds,
  fidelityLabel,
  engineLabel,
  recordByUid,
  latestRecordByUid,
  renderCounts,
} from './composition/format';

const FPS = DEFAULT_FPS;
const SEED_MS = 8_400; // mock design-fixture snapshot — c02 problem active

const MOCK_MODEL: TimelineModel = {
  clips: COMPOSITION_TIMELINE,
  totalMs: COMPOSITION_TOTAL_MS,
  meta: COMPOSITION_META as TimelineModel['meta'],
  narration: COMPOSITION_NARRATION,
};

// Real music presets (sidecar MUSIC_PRESETS). none/silent are silent by design;
// ambient/upbeat need assets/music/<preset>.mp3 on disk (F7).
const MUSIC_PRESETS: Array<{ value: string; label: string }> = [
  { value: 'upbeat', label: 'Upbeat' },
  { value: 'ambient', label: 'Ambient' },
  { value: 'silent', label: 'Silent' },
  { value: 'none', label: 'No music' },
];

function aspectAttr(aspect: string): PreviewAspect {
  if (aspect === '9:16') return '9-16';
  if (aspect === '1:1') return '1-1';
  return '16-9';
}

export function CompositionView() {
  const playheadMs = useSharedStore(selectPlayheadMs);
  const cellUid = useSharedStore(selectCellUid);
  const hoverBeat = useSharedStore(selectHoverBeat);
  const engineMode = useSharedStore(selectEngineMode);
  const setPlayheadMs = useSharedStore((s) => s.setPlayheadMs);
  const setCellUid = useSharedStore((s) => s.setCellUid);
  const setHoverBeat = useSharedStore((s) => s.setHoverBeat);
  const setEngineMode = useSharedStore((s) => s.setEngineMode);

  const project = useProjectStore(selectOpenProject);
  const hasRealCells = useStoryboardStore(selectHasRealCells);
  const hydratedCells = useStoryboardStore(selectHydratedCells);
  const projectDoc = useStoryboardStore(selectHydratedProject);
  const renderStatus = useStoryboardStore(selectRenderStatus);
  const renderRecords = useStoryboardStore(selectRenderRecords);
  const lastSyncedAt = useStoryboardStore(selectLastSyncedAt);
  const refreshRenders = useStoryboardStore((s) => s.refreshRenders);
  const bumpActivePoll = useStoryboardStore((s) => s.bumpActivePoll);

  const model = useMemo<TimelineModel>(
    () => (hasRealCells ? buildTimelineModel(hydratedCells, projectDoc, renderStatus) : MOCK_MODEL),
    [hasRealCells, hydratedCells, projectDoc, renderStatus],
  );
  const { clips, totalMs, meta, narration } = model;

  // Per-cell render record (latest done wins) + per-cell rung — used for the
  // records table, byte-playback, and the per-clip fidelity label (fixes the
  // stale global-rung finding).
  const recByUid = useMemo(() => (hasRealCells ? recordByUid(renderRecords) : {}), [hasRealCells, renderRecords]);
  // Latest (not best-ever) render record per cell, for the "N / M rendered"
  // banner only (G-106) — everything else above keeps using recByUid's
  // best-status pick (filmstrip poster, byte-playback, records table).
  const latestByUid = useMemo(
    () => (hasRealCells ? latestRecordByUid(renderRecords) : {}),
    [hasRealCells, renderRecords],
  );
  const cellByUid = useMemo(() => {
    const m: Record<string, Cell> = {};
    for (const c of hydratedCells) m[c.uid] = c;
    return m;
  }, [hydratedCells]);

  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [muted, setMuted] = useState(false);
  const [musicPreset, setMusicPreset] = useState('upbeat');
  const [bedCheck, setBedCheck] = useState<BedCheck | null>(null);

  const [rerenderState, setRerenderState] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
  // cell_uids whose render() ENQUEUE call itself rejected (not a render-job
  // failure after a successful enqueue — those are already visible via the
  // per-clip badge/glyph). Tracked separately from rerenderState so a single
  // retryClip() failure can surface without stomping a concurrent bulk run.
  const [failedEnqueueUids, setFailedEnqueueUids] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  // Export state machine.
  const [exportState, setExportState] = useState<ExportUiState>('idle');
  const [exportPath, setExportPath] = useState<string | null>(null);
  const [exportId, setExportId] = useState<string | null>(null);
  const [exportSilent, setExportSilent] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [composedMode, setComposedMode] = useState(false);
  const exportAbortRef = useRef<{ aborted: boolean }>({ aborted: false });

  // Per-cell video availability → drives whether we show the video or the poster.
  const [videoState, setVideoState] = useState<CellVideoAvailability>('unavailable');

  const loopRef = useRef(loop);
  loopRef.current = loop;

  // ── Engine player seam (transport clock) ────────────────────────────────
  const playerRef = useRef<PlayerHandle | null>(null);
  useEffect(() => {
    const player = createMockPlayer({ totalFrames: msToFrames(totalMs, FPS), fps: FPS });
    playerRef.current = player;
    player.setLoop(loopRef.current);
    const offFrame = player.onFrameUpdate((frame) => setPlayheadMs(framesToMs(frame, FPS)));
    const offPlay = player.onPlayStateChange(setPlaying);
    const startMs = hasRealCells ? 0 : (useSharedStore.getState().playheadMs || SEED_MS);
    player.seekTo(msToFrames(snapMsToFrame(startMs, FPS), FPS));
    return () => {
      offFrame();
      offPlay();
      player.destroy();
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalMs, hasRealCells]);

  // ── Bed check for the silent-bed warning (F7) ───────────────────────────
  // The precise seam is export.check_bed (existsSync on assets/music/<preset>.mp3);
  // when it's unavailable (mock, or a running MCP server that predates the tool)
  // we fall back to the sidecar's own contract — none/silent are silent by
  // design, and ambient/upbeat need a bed file that isn't bundled → silent —
  // so the honest warning still shows, then upgrades to the exact disk-check.
  const contractBed = (preset: string): BedCheck => {
    const byDesign = preset === 'none' || preset === 'silent';
    return { has_bed: false, will_be_silent: true, by_design: byDesign };
  };
  useEffect(() => {
    if (!hasRealCells) {
      setBedCheck(contractBed(musicPreset));
      return;
    }
    let cancelled = false;
    const projectId = project?.project_id;
    if (!projectId) return;
    (async () => {
      try {
        const client = await getMcpClient();
        const res = await exportApi.check_bed(client, { project_id: projectId, music_preset: musicPreset });
        if (!cancelled) setBedCheck(res);
      } catch {
        if (!cancelled) setBedCheck(contractBed(musicPreset));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [musicPreset, hasRealCells, project?.project_id]);

  // ── Seek authority + transport handlers ─────────────────────────────────
  const seekMs = (ms: number) => {
    const p = playerRef.current;
    if (!p) return;
    p.seekTo(msToFrames(snapMsToFrame(ms, FPS), FPS));
  };
  const onSelectMs = (ms: number) => {
    const clip = clipAt(clips, ms);
    if (clip) setCellUid(clip.uid);
  };
  const onHoverMs = (ms: number | null) => {
    setHoverBeat(ms !== null ? (clipAt(clips, ms)?.uid ?? null) : null);
  };
  const playToggle = () => {
    const p = playerRef.current;
    if (!p) return;
    if (p.isPlaying()) p.pause();
    else p.play();
  };
  const stepFrames = (delta: number) => {
    seekMs(framesToMs(msToFrames(playheadMs, FPS) + delta, FPS));
  };
  const loopToggle = () => {
    const next = !loop;
    setLoop(next);
    playerRef.current?.setLoop(next);
  };
  const onClipClick = (clip: TimelineClip) => {
    setCellUid(clip.uid);
    seekMs(clip.start_ms);
  };

  // ── Render / retry over MCP ──────────────────────────────────────────────
  // uidsOverride lets the "Retry failed" affordance re-enqueue just the
  // cell_uids that failed last time, reusing the same enqueue/poll path.
  const rerenderAll = async (uidsOverride?: string[]) => {
    if (rerenderState === 'running') return;
    const projectId = project?.project_id;
    if (!projectId) return;
    const cellUids = uidsOverride ?? clips.map((c) => c.uid);
    setRerenderState('running');
    try {
      const client = await getMcpClient();
      const failedUids: string[] = [];
      const recordIds = (
        await Promise.all(
          cellUids.map((uid) =>
            compositionApi
              .render(client, { project_id: projectId, cell_uid: uid })
              .then((r) => r.record_id)
              .catch(() => {
                failedUids.push(uid);
                return null;
              }),
          ),
        )
      ).filter((r): r is string => Boolean(r));
      bumpActivePoll();
      void refreshRenders();
      await Promise.all(recordIds.map((rid) => pollRenderUntilDone(client, rid)));
      void refreshRenders();
      if (failedUids.length > 0) {
        // A failed enqueue for cells not in this batch (e.g. a prior failed
        // retry-failed run) shouldn't be silently dropped from the banner.
        setFailedEnqueueUids((prev) => Array.from(new Set([...prev.filter((u) => !cellUids.includes(u)), ...failedUids])));
        setRerenderState('failed');
      } else {
        setFailedEnqueueUids((prev) => prev.filter((u) => !cellUids.includes(u)));
        setRerenderState('done');
        window.setTimeout(() => setRerenderState('idle'), 1600);
      }
    } catch (err) {
      // The whole batch threw (e.g. getMcpClient() itself failed) — every
      // requested cell_uid is unaccounted for, not just the ones that made
      // it into a per-cell .catch().
      setFailedEnqueueUids((prev) => Array.from(new Set([...prev, ...cellUids])));
      setRerenderState('failed');
      // eslint-disable-next-line no-console
      console.error('[studio] re-render all failed', err);
    }
  };

  const retryClip = async (uid: string) => {
    const projectId = project?.project_id;
    if (!projectId) return;
    try {
      const client = await getMcpClient();
      setCellUid(uid);
      await compositionApi.render(client, { project_id: projectId, cell_uid: uid });
      setFailedEnqueueUids((prev) => {
        const next = prev.filter((u) => u !== uid);
        if (next.length === 0) setRerenderState((s) => (s === 'failed' ? 'idle' : s));
        return next;
      });
      bumpActivePoll();
      void refreshRenders();
    } catch (err) {
      setFailedEnqueueUids((prev) => (prev.includes(uid) ? prev : [...prev, uid]));
      setRerenderState('failed');
      // eslint-disable-next-line no-console
      console.error('[studio] retry render failed', err);
    }
  };

  // Stable so the memoized <RecordsPanel> (review §2.2/2.6) can actually bail
  // on its onRefresh prop instead of seeing a fresh function every render.
  const onRefreshRecords = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshRenders();
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, refreshRenders]);

  // ── Export flow: pre-flight → compose → running → done | error ──────────
  const runExport = async () => {
    const projectId = project?.project_id;
    if (!projectId) return;
    setComposedMode(false);
    setExportState('running');
    setExportError(null);
    exportAbortRef.current = { aborted: false };
    const signal = exportAbortRef.current;
    try {
      const client = await getMcpClient();
      const { export_id, export_path } = await exportApi.compose(client, {
        project_id: projectId,
        rung: hasRealCells ? undefined : meta.rung,
        music_preset: musicPreset,
      });
      setExportId(export_id);
      bumpActivePoll();
      const rec = await pollExportUntilDone(client, export_id, { signal });
      if (signal.aborted) return;
      if (rec && rec.status === 'failed') {
        setExportError('The export failed before finishing. Nothing was written to disk.');
        setExportState('error');
        return;
      }
      setExportPath(rec?.output_uri ?? export_path);
      // Honest silent-flag: a bed that isn't on disk means the export went out
      // video-only (F7). Intentional silence (preset none/silent, by_design)
      // is not a warning — same rule as the pre-flight's showSilentNotice.
      setExportSilent(Boolean(bedCheck?.will_be_silent && !bedCheck?.by_design));
      setExportState('done');
    } catch (err) {
      if (signal.aborted) return;
      setExportError((err as Error).message);
      setExportState('error');
    }
  };

  const cancelExport = () => {
    exportAbortRef.current.aborted = true;
    setExportState('idle');
  };

  // ── Derived state ───────────────────────────────────────────────────────
  const activeClip = clipAt(clips, playheadMs);
  const activeRecord = activeClip ? recByUid[activeClip.uid] : undefined;
  const activeRecordId = activeRecord && activeRecord.status === 'done' ? activeRecord.id : null;
  const activeCell = activeClip ? cellByUid[activeClip.uid] : undefined;
  const activeRung = activeCell?.rung ?? (hasRealCells ? undefined : meta.rung);

  const activeWord = narration?.words.find((w) => playheadMs >= w.start_ms && playheadMs < w.end_ms);
  const bannerCounts = useMemo(() => renderCounts(clips, latestByUid), [clips, latestByUid]);
  const renderedCount = bannerCounts.rendered;
  const failedRenderCount = bannerCounts.failed;
  const fullyRendered = clips.length > 0 && renderedCount === clips.length;
  const playheadPct = Math.min(100, Math.max(0, (playheadMs / totalMs) * 100));
  const clipIndex = activeClip ? clips.findIndex((c) => c.uid === activeClip.uid) : -1;

  // Silent warning: preset expects a bed but none is on disk (NOT the intentional
  // none/silent case).
  const showSilentNotice = Boolean(bedCheck && bedCheck.will_be_silent && !bedCheck.by_design);
  const presetLabel = MUSIC_PRESETS.find((p) => p.value === musicPreset)?.label ?? musicPreset;

  const clipStateClass = (c: TimelineClip): string => {
    const st = recByUid[c.uid]?.status ?? c.status;
    if (st === 'running') return ' is-rendering';
    if (st === 'queued') return ' is-queued';
    if (st === 'done') return ' is-done';
    if (st === 'failed') return ' is-failed';
    if (st === 'cancelled') return ' is-cancelled';
    if (st === undefined) return ' is-pending';
    return '';
  };
  const clipGlyph = (c: TimelineClip): string | null => {
    const st = recByUid[c.uid]?.status ?? c.status;
    if (st === 'running') return '◐';
    if (st === 'queued' || st === undefined) return '○';
    if (st === 'done') return '✓';
    if (st === 'failed') return '⚠';
    if (st === 'cancelled') return '✕';
    return null;
  };

  const previewWords = useMemo(() => {
    if (!activeClip || !narration) return [];
    return narration.words.filter(
      (w) => w.start_ms >= activeClip.start_ms && w.end_ms <= activeClip.start_ms + activeClip.duration_ms,
    );
  }, [activeClip, narration]);

  // ── Right-slot: music + re-render (kept from the transport family) ───────
  const rightSlot = (
    <>
      <button
        type="button"
        className={`transport-btn${muted ? '' : ' is-on'}`}
        aria-label={muted ? 'Unmute audio' : 'Mute audio'}
        aria-pressed={!muted}
        onClick={() => setMuted((m) => !m)}
      >
        {muted ? '🔇' : '🔊'}
      </button>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        aria-label="Re-render all cells"
        onClick={() => void rerenderAll()}
        disabled={rerenderState === 'running'}
        aria-busy={rerenderState === 'running'}
      >
        {rerenderState === 'running'
          ? 'Rendering…'
          : rerenderState === 'done'
            ? 'Rendered ✓'
            : rerenderState === 'failed'
              ? '⚠ Enqueue failed'
              : '↻ Re-render all'}
      </button>
    </>
  );

  // ── Empty edge state: no cells on the timeline yet ──────────────────────
  if (clips.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-base p-8 text-center">
        <span className="font-display text-sm text-fg-muted">Nothing to play yet</span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">
          render cells to populate the timeline
        </span>
      </div>
    );
  }

  const onViewKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(target.tagName)) return;
    if (target.closest('.scrubber')) return;
    if (e.key === ' ') {
      e.preventDefault();
      playToggle();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      const targetIdx = clipIndex === -1 ? (dir > 0 ? 0 : clips.length - 1) : clipIndex + dir;
      const clamped = Math.max(0, Math.min(clips.length - 1, targetIdx));
      const clip = clips[clamped];
      if (clip) seekMs(clip.start_ms);
    }
  };

  const archetypeName = project?.archetype_id
    ? project.archetype_id.charAt(0).toUpperCase() + project.archetype_id.slice(1)
    : 'Explainer';

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-auto bg-base"
      data-workspace="studio"
      onKeyDown={onViewKeyDown}
    >
      {/* shrink-0 is load-bearing: the parent scroller is a flex column, so
          without it this frame (overflow:hidden) compresses to the pane height
          instead of overflowing — the scroller then has nothing to scroll and
          the timeline/records get clipped. */}
      <div className="composition-frame comp-cockpit m-2 shrink-0">
        {/* Header */}
        <header className="comp-header">
          <div className="comp-header__title">
            <h1>{meta.name}</h1>
            <div className="comp-header__meta">
              <span className="kicker">Composition</span>
              <span className="comp-dot">·</span>
              <span>{archetypeName}</span>
              <span className="comp-dot">·</span>
              <span>{meta.aspect} · {meta.resolution.w}×{meta.resolution.h}</span>
              <span className="comp-dot">·</span>
              <span>{fmtSeconds(totalMs)} · {clips.length} cells</span>
            </div>
          </div>
          <div className="comp-header__right">
            <span className="comp-pill" title="Rendering engine">
              ⚡ HyperFrames · <b>{fidelityLabel(activeRung ?? meta.rung)}</b>
            </span>
            <span
              className={`comp-pill${fullyRendered ? ' is-ok' : ''}`}
              title="Cells whose latest render attempt is done or failed"
            >
              {fullyRendered ? '✓ ' : ''}{renderedCount} / {clips.length} rendered
              {failedRenderCount > 0 ? ` · ${failedRenderCount} failed` : ''}
            </span>
          </div>
        </header>

        {/* Enqueue-failure banner: a render() call itself rejected (network,
            sidecar down, etc.) before a record ever existed to badge — the
            per-clip glyphs can't show this, so it needs its own surface. */}
        {failedEnqueueUids.length > 0 && (
          <div className="comp-notice" role="alert">
            <span aria-hidden="true">⚠</span>
            <span>
              <b>{failedEnqueueUids.length} cell{failedEnqueueUids.length === 1 ? '' : 's'}</b> failed to
              enqueue for render: {failedEnqueueUids.join(', ')}.
            </span>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              aria-label="Retry failed enqueues"
              onClick={() => void rerenderAll(failedEnqueueUids)}
              disabled={rerenderState === 'running'}
            >
              ↺ Retry failed
            </button>
          </div>
        )}

        {/* Engine sub-tabs */}
        <div className="engine-tabs-row">
          <div className="seg" role="tablist" aria-label="Engine view">
            <button
              type="button"
              className={engineMode === 'hf' ? 'is-on' : ''}
              role="tab"
              aria-selected={engineMode === 'hf'}
              onClick={() => setEngineMode('hf')}
            >
              HF Player
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={false}
              disabled
              title="Remotion Studio — Phase 2"
              aria-label="Remotion Studio, Phase 2 (locked)"
            >
              Remotion Studio <span className="engine-badge">P2</span>
            </button>
          </div>
          <div className="comp-nowclip">
            {activeClip ? (
              <>Now: <b>{activeClip.beat}</b> · {fmtClock(activeClip.start_ms)}–{fmtClock(activeClip.start_ms + activeClip.duration_ms)}</>
            ) : (
              <>End of composition</>
            )}
          </div>
        </div>

        {/* Stage: viewer column + tool rail (C-A). Collapses to one column at
            narrow pane widths — see .comp-stage in studio-editor.css. */}
        <div className="comp-stage">
          <section className="comp-viewer" aria-label="Video preview">
            {/* Preview surface */}
            <PreviewSurface
              aspect={aspectAttr(meta.aspect)}
              safeZoneOn
              status={
                composedMode
                  ? 'ready'
                  : !activeClip
                    ? 'ready'
                    : (activeRecord?.status ?? activeClip.status) === 'done'
                      ? 'ready'
                      : (activeRecord?.status ?? activeClip.status) === 'running'
                        ? 'rendering'
                        : (activeRecord?.status ?? activeClip.status) === 'queued'
                          ? 'queued'
                          : (activeRecord?.status ?? activeClip.status) === 'failed'
                            ? 'failed'
                            : (activeRecord?.status ?? activeClip.status) === 'cancelled'
                              ? 'cancelled'
                              : 'pending'
              }
              ariaLabel={
                composedMode
                  ? 'Composed export playback'
                  : activeClip
                    ? `Composition preview — cell ${activeClip.uid} ${activeClip.beat}`
                    : 'Composition preview — end of composition'
              }
            >
              {composedMode && exportId ? (
                <ComposedVideo exportId={exportId} muted={muted} onExit={() => setComposedMode(false)} />
              ) : !activeClip ? (
                <div className="preview-status">
                  <span className="preview-status-text">— end of composition —</span>
                </div>
              ) : (activeRecord?.status ?? activeClip.status) === 'done' ? (
                <div className="comp-viewer-stage">
                  {/* Real per-cell pixels overlay; poster + caption behind it. */}
                  <CellVideo
                    recordId={activeRecordId}
                    playing={playing}
                    muted={muted}
                    playheadMs={playheadMs}
                    clipStartMs={activeClip.start_ms}
                    onAvailability={setVideoState}
                  />
                  <div className={`comp-poster${videoState === 'ready' ? ' is-hidden' : ''}`} aria-hidden={videoState === 'ready'}>
                    <div
                      className="preview-cell-label"
                      style={{ color: `var(--beat-accent-${activeClip.accent})` }}
                    >
                      {activeClip.beat}
                    </div>
                    <div className="preview-narration">
                      {previewWords.length > 0 ? (
                        previewWords.map((w) => {
                          const isActive = activeWord?.word === w.word && activeWord?.start_ms === w.start_ms;
                          const isPast = playheadMs >= w.end_ms;
                          return (
                            <span
                              key={`${w.word}-${w.start_ms}`}
                              className={'preview-word' + (isActive ? ' is-active' : isPast ? ' is-past' : '')}
                            >
                              {w.word}
                            </span>
                          );
                        })
                      ) : (
                        <span className="preview-word is-active">{activeClip.beat}</span>
                      )}
                    </div>
                    <div className="preview-engine-note">
                      HyperFrames · {fidelityLabel(activeRung ?? meta.rung)}
                      {videoState === 'unavailable' && ' · rendered — preview unavailable, try Refresh'}
                    </div>
                  </div>
                  {/* Clip badge + play overlay */}
                  <div className="comp-clip-badge" aria-hidden="true">
                    <span className="comp-clip-badge__dot" style={{ background: `var(--beat-accent-${activeClip.accent})` }} />
                    {activeClip.uid} · {fmtClock(activeClip.start_ms)}–{fmtClock(activeClip.start_ms + activeClip.duration_ms)}
                  </div>
                  <button
                    type="button"
                    className={`comp-play-overlay${playing ? ' is-playing' : ''}`}
                    aria-label={playing ? 'Pause composition' : 'Play composition'}
                    onClick={playToggle}
                  >
                    <span aria-hidden="true">{playing ? '❚❚' : '▶'}</span>
                  </button>
                </div>
              ) : (activeRecord?.status ?? activeClip.status) === undefined ? (
                // Explicit EMPTY preview (C-B graft): nothing rendered for this cell.
                <div className="comp-empty-preview">
                  <div className="preview-cell-label" style={{ color: `var(--beat-accent-${activeClip.accent})` }}>
                    {activeClip.beat}
                  </div>
                  <span className="preview-status-text">Not rendered yet</span>
                  <button
                    type="button"
                    className="btn btn-sm comp-btn-primary"
                    onClick={() => retryClip(activeClip.uid)}
                    aria-label={`Render ${activeClip.beat} cell`}
                  >
                    ⚡ Render this cell
                  </button>
                </div>
              ) : (
                <div style={{ textAlign: 'center' }}>
                  <div className="preview-cell-label" style={{ color: `var(--beat-accent-${activeClip.accent})` }}>
                    {activeClip.beat}
                  </div>
                  <PreviewStatus
                    glyph={
                      (activeRecord?.status ?? activeClip.status) === 'running'
                        ? '◐'
                        : (activeRecord?.status ?? activeClip.status) === 'failed'
                          ? '⚠'
                          : (activeRecord?.status ?? activeClip.status) === 'cancelled'
                            ? '✕'
                            : '○'
                    }
                    text={(activeRecord?.status ?? activeClip.status) ?? 'pending'}
                    action={
                      (activeRecord?.status ?? activeClip.status) === 'failed' ? (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          aria-label={`Retry render for ${activeClip.beat}`}
                          onClick={() => retryClip(activeClip.uid)}
                        >
                          ↺ Retry
                        </button>
                      ) : undefined
                    }
                  />
                </div>
              )}
            </PreviewSurface>

            {/* Transport — beneath the picture it drives (C-A) */}
            <TransportBar
              playing={playing}
              onPlayToggle={playToggle}
              onStepBack={() => stepFrames(-1)}
              onStepForward={() => stepFrames(1)}
              loop={loop}
              onLoopToggle={loopToggle}
              currentMs={playheadMs}
              totalMs={totalMs}
              fps={FPS}
              counterLabel={`${renderedCount}/${clips.length} cells rendered`}
              rightSlot={rightSlot}
            />
          </section>

          {/* Rail cards */}
          <aside className="comp-rail" aria-label="Composition tools">
            {/* Active cell inspector */}
            <div className="comp-card">
              <header className="comp-card__head"><span className="kicker">Active cell</span></header>
              <div className="comp-card__body">
                {activeClip ? (
                  <>
                    <div className="comp-insp-title">
                      <span className="comp-swatch" data-accent={activeClip.accent} aria-hidden="true" />
                      <h3>{activeClip.beat}</h3>
                    </div>
                    <dl className="comp-kv">
                      <dt>In / Out</dt>
                      <dd>{fmtClock(activeClip.start_ms)} – {fmtClock(activeClip.start_ms + activeClip.duration_ms)}</dd>
                      <dt>Duration</dt>
                      <dd>{fmtSeconds(activeClip.duration_ms)}</dd>
                      <dt>Fidelity</dt>
                      <dd>
                        {fidelityLabel(activeRung ?? meta.rung)}
                        {(activeRecord?.status ?? activeClip.status) === 'done' ? ' · rendered' : ''}
                      </dd>
                      <dt>Engine</dt>
                      {/* The engine is a property of the render that exists, not of
                          the pkg — an excalidraw cell or a Track-B ingest is neither
                          HyperFrames nor a guess. No record ⇒ nothing to name. */}
                      <dd>{activeRecord ? engineLabel(activeRecord.engine) : '—'}</dd>
                    </dl>
                  </>
                ) : (
                  <p className="comp-dim">Scrub the timeline to inspect a cell.</p>
                )}
              </div>
            </div>

            {/* Audio bed */}
            <div className="comp-card">
              <header className="comp-card__head"><span className="kicker">Audio bed</span></header>
              <div className="comp-card__body">
                <div className="comp-fieldrow">
                  <label htmlFor="comp-music">Music</label>
                  <select
                    id="comp-music"
                    className="input comp-input"
                    aria-label="Music preset"
                    value={musicPreset}
                    onChange={(e) => setMusicPreset(e.target.value)}
                  >
                    {MUSIC_PRESETS.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </div>

                {showSilentNotice && (
                  <div className="comp-notice" role="status">
                    <span aria-hidden="true">⚠</span>
                    <span>
                      <b>No track on disk.</b> This preset has no audio file yet — the export
                      will be video-only (silent) until one is added.
                    </span>
                  </div>
                )}

                {!narration && (
                  <div className="comp-narr-empty">
                    <span className="comp-dim">No narration yet — the waveform appears once it’s generated.</span>
                    <details className="comp-narr-how">
                      <summary>How do I add narration?</summary>
                      Ask your Chi in the chat dock to generate narration for this project — it
                      writes the narration track and word timings the waveform reads.
                    </details>
                  </div>
                )}
              </div>
            </div>

            {/* Export */}
            <ExportCard
              state={exportState}
              exportPath={exportPath}
              wasSilent={exportSilent}
              errorMessage={exportError}
              metaLine={`${meta.resolution.w}×${meta.resolution.h} · ${fmtSeconds(totalMs)} · H.264`}
              composedAvailable={Boolean(exportId)}
              onExportClick={() => setPreflightOpen(true)}
              onCancel={cancelExport}
              onExportAgain={() => setExportState('idle')}
              onRetry={() => void runExport()}
              onPlayComposed={() => setComposedMode(true)}
            />
          </aside>
        </div>

        {/* Timeline section — ruler + filmstrip + scrubber */}
        <div className="timeline-section">
          <TimeRuler totalMs={totalMs} fps={FPS} />
          <div
            className={`timeline-rail${playing ? ' is-playing' : ''}`}
            style={{ ['--total-ms' as string]: String(totalMs) }}
            role="presentation"
          >
            {clips.map((c, i) => {
              const flexBasis = `${(c.duration_ms / totalMs) * 100}%`;
              const prev = i > 0 ? clips[i - 1] : null;
              const showMarker = c.transition && c.transition !== 'cut' && prev;
              const selected = c.uid === cellUid || c.uid === activeClip?.uid ? ' is-selected' : '';
              const hoverLinked = hoverBeat === c.uid ? ' is-hover-link' : '';
              const glyph = clipGlyph(c);
              const st = recByUid[c.uid]?.status ?? c.status;
              return (
                <div
                  key={c.uid}
                  className={`clip-segment${clipStateClass(c)}${selected}${hoverLinked}`}
                  data-accent={c.accent}
                  role="button"
                  tabIndex={0}
                  aria-label={`${c.beat} cell, ${st ?? 'pending'}, ${Math.round(c.duration_ms / 1000)} seconds`}
                  style={{ flexBasis }}
                  onClick={() => onClipClick(c)}
                  onFocus={() => setHoverBeat(c.uid)}
                  onBlur={() => setHoverBeat(null)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onClipClick(c);
                    }
                  }}
                >
                  {showMarker && (
                    <div
                      className="transition-marker"
                      data-transition={c.transition}
                      style={{ background: `linear-gradient(to right, var(--beat-accent-${prev!.accent}-soft) 0%, transparent 70%)` }}
                      aria-hidden="true"
                    />
                  )}
                  {st === 'done' && (() => {
                    const rid = recByUid[c.uid]?.id;
                    return rid ? (
                      <CellPoster
                        recordId={rid}
                        alt={c.beat}
                        className="clip-segment__poster"
                      />
                    ) : null;
                  })()}
                  <span className="clip-segment__label">{c.beat}</span>
                  {glyph && <span className="clip-segment__glyph" aria-hidden="true">{glyph}</span>}
                </div>
              );
            })}
            <ScrubberPlayhead
              currentMs={playheadMs}
              totalMs={totalMs}
              fps={FPS}
              onSeekMs={seekMs}
              onSelectMs={onSelectMs}
              onHoverMs={onHoverMs}
            />
          </div>

          {/* Narration waveform / empty treatment */}
          {narration ? (
            <>
              <div
                className={`waveform-strip${playing ? ' is-playing' : ''}`}
                role="img"
                aria-label={`Narration waveform — ${narration.audio.uri}`}
                style={{ ['--bar-count' as string]: String(WAVEFORM_BAR_COUNT) }}
              >
                <span className="waveform-strip__label" aria-hidden="true">{narration.audio.uri}</span>
                {WAVEFORM_BARS.map((h, i) => {
                  const barStart = (i / WAVEFORM_BAR_COUNT) * totalMs;
                  const played = barStart < playheadMs;
                  const active =
                    playheadMs >= (i / WAVEFORM_BAR_COUNT) * totalMs &&
                    playheadMs < ((i + 1) / WAVEFORM_BAR_COUNT) * totalMs;
                  return (
                    <div
                      key={i}
                      className={`waveform-bar${active ? ' is-active' : played ? ' is-played' : ''}`}
                      style={{ ['--bar-h' as string]: `${h}%` }}
                    />
                  );
                })}
                <PlayheadEcho leftPct={playheadPct} />
              </div>
              <div className="word-strip" aria-hidden="true">
                {narration.words.map((w) => {
                  const isActive = activeWord?.word === w.word && activeWord?.start_ms === w.start_ms;
                  const isPast = playheadMs >= w.end_ms;
                  return (
                    <span
                      key={`${w.word}-${w.start_ms}`}
                      className={'word-strip-word' + (isActive ? ' is-active' : isPast ? ' is-past' : '')}
                    >
                      {w.word}
                    </span>
                  );
                })}
              </div>
            </>
          ) : (
            <div
              className="waveform-strip is-empty"
              role="img"
              aria-label="No narration yet — waveform appears after narration is generated"
            >
              <span className="waveform-empty-note">no narration · generate it to see the waveform</span>
              <PlayheadEcho leftPct={playheadPct} />
            </div>
          )}
        </div>

        {/* Render records truth surface (C-C) */}
        <RecordsPanel
          clips={clips}
          recordByUid={recByUid}
          lastSyncedAt={hasRealCells ? lastSyncedAt : null}
          fps={FPS}
          refreshing={refreshing}
          onRefresh={onRefreshRecords}
        />
      </div>

      {/* Export pre-flight dialog (C-B) */}
      <ExportPreflightDialog
        open={preflightOpen}
        spec={{
          format: 'MP4 · H.264',
          resolution: `${meta.resolution.w} × ${meta.resolution.h}`,
          duration: `${fmtSeconds(totalMs)} · ${FPS} fps`,
          coverage: `${renderedCount} of ${clips.length} rendered`,
          fullyRendered,
        }}
        presetLabel={presetLabel}
        willBeSilent={showSilentNotice}
        onCancel={() => setPreflightOpen(false)}
        onConfirm={() => {
          setPreflightOpen(false);
          void runExport();
        }}
      />
    </div>
  );
}
