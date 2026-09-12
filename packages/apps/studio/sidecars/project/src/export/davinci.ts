/**
 * DaVinci Resolve Timeline Exporter & OTIO/FCPXML Bridge (WP-23 / WP-24, Plan 24).
 *
 * Assembles a project's rendered storyboard cells, audio beds, and
 * beat-detect transients into a multi-track DaVinci Resolve timeline
 * or an interchangeable FCPXML/OTIO file.
 *
 * ─── RPC Reachability (G-75 #1) ───────────────────────────────────────────
 * `export.davinci_timeline` is registered in rpc.ts's EXTENDED_METHODS —
 * the handler here existed since WP-23 but was unreachable over stdio
 * (method-not-found) until that registration landed alongside this fix.
 *
 * ─── Health Check (G-52 / G-75 #4) ───────────────────────────────────────
 * 5-second async health-check via DaVinciResolveScript.scriptapp("Resolve").
 * The spawned interpreter is given the documented Blackmagic env vars
 * (RESOLVE_SCRIPT_API / RESOLVE_SCRIPT_LIB / PYTHONPATH) per-platform so the
 * check can actually succeed on a default Resolve Studio install, not just
 * on a machine where a developer hand-exported them. Returns
 * `RESOLVE_NOT_RUNNING` error if unreachable — that failure stays fast: an
 * absent/unreachable Resolve exits the scripting call in well under 5s.
 *
 * ─── Frame Quantization (G-53 / G-75 #6) ─────────────────────────────────
 * Every clip's duration is the DIFFERENCE of two absolute running-total
 * frame boundaries (`msToFrames(end) - msToFrames(start)`), never
 * `msToFrames(duration)` computed per cell in isolation — the latter drifts
 * a frame in/out of alignment with the next clip's offset whenever a cell's
 * duration doesn't itself land on a frame boundary.
 *
 * ─── Beat Sync Markers (G-56 / G-75 #8) ──────────────────────────────────
 * Ingests `downbeats` (Blue "Downbeat"), `beats` (Purple "Beat"), and
 * `onsets` (Yellow "Transient") from `audio_analysis`. Injection is gated by
 * `enableBeatSync` (default true — matches the historical always-on
 * behavior when the flag isn't passed).
 *
 * ─── FCPXML Validity (G-75 #2) ────────────────────────────────────────────
 * Per the FCPXML DTD, `<asset-clip>` cannot carry a bare `src=` — it must
 * `ref=` an `<asset>` declared under `<resources>` (with a `<media-rep>`).
 * `<marker>` elements are only valid as children of a clip-like element
 * (timed relative to that clip's local timeline), never as direct children
 * of `<spine>`. Both are honored here: one deduped `<asset>` per source
 * file, and markers attached to whichever asset-clip covers their absolute
 * time (dropped, not mis-nested, if no clip covers that instant — e.g. a
 * still-unrendered gap).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import type { Project, Cell, RenderRecord } from '@ikenga/studio-schema';

export const DEFAULT_FPS = 30;

export const msToFrames = (ms: number, fps: number = DEFAULT_FPS): number =>
  Math.round((ms / 1000) * fps);

export interface DaVinciExportOptions {
  projectId: string;
  project: Project;
  projectRoot: string;
  rendersDir: string;
  rung?: number;
  cellIds?: string[];
  outputPath?: string;
  fps?: number;
  enableBeatSync?: boolean;
}

export interface DaVinciExportResult extends Record<string, unknown> {
  ok: boolean;
  exportId?: string;
  outputPath?: string;
  timelineName?: string;
  trackCount?: { video: number; audio: number };
  markersCount?: number;
  error?: string;
  message?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Escaping helpers (G-75 #9)
// ─────────────────────────────────────────────────────────────────────────

/** Escape text for use inside an XML double-quoted attribute value. */
export function escapeXmlAttr(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Escape text for use as XML element content. */
export function escapeXmlText(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Embed a string as a Python source string literal. JSON string syntax
 * (backslash/quote/control-char escaping) is a valid subset of Python's
 * double-quoted string literal syntax, so `JSON.stringify` is a safe,
 * dependency-free way to interpolate untrusted text (project titles, etc.)
 * into generated Python source without it breaking out of the literal.
 */
export function pyStringLiteral(s: string): string {
  return JSON.stringify(String(s));
}

/** Strip path separators and other filesystem-hostile characters from a
 *  string destined for use as a single filename component. */
export function sanitizeFilenameComponent(s: string): string {
  return String(s)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .replace(/\.+$/, '')
    .slice(0, 180) || 'untitled';
}

// ─────────────────────────────────────────────────────────────────────────
// Interpreter / environment resolution (G-75 #4)
// ─────────────────────────────────────────────────────────────────────────

/** Resolve the python interpreter to spawn. Overridable via
 *  `RESOLVE_PYTHON_BIN`; otherwise `py` on Windows (this toolchain's
 *  convention — plain `python` is frequently absent on PATH) and `python3`
 *  elsewhere. */
export function resolvePythonBin(): string {
  if (process.env.RESOLVE_PYTHON_BIN && process.env.RESOLVE_PYTHON_BIN.trim().length > 0) {
    return process.env.RESOLVE_PYTHON_BIN;
  }
  return process.platform === 'win32' ? 'py' : 'python3';
}

/**
 * Build the DaVinci Resolve scripting env vars per Blackmagic's documented
 * defaults for each platform, layered under whatever the process env
 * already has set (an operator's explicit `RESOLVE_SCRIPT_API` etc. always
 * wins). Without these, `import DaVinciResolveScript` fails even when
 * Resolve Studio is running, on a completely default install.
 */
export function resolveDaVinciEnv(
  platform: NodeJS.Platform = process.platform,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  let apiDefault: string;
  let libDefault: string;
  let modulesSep: string;

  if (platform === 'win32') {
    const programData = base.PROGRAMDATA || 'C:\\ProgramData';
    const programFiles = base.ProgramFiles || 'C:\\Program Files';
    apiDefault = join(programData, 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Developer', 'Scripting');
    libDefault = join(programFiles, 'Blackmagic Design', 'DaVinci Resolve', 'fusionscript.dll');
    modulesSep = ';';
  } else if (platform === 'darwin') {
    apiDefault = '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting';
    libDefault = '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so';
    modulesSep = ':';
  } else {
    apiDefault = '/opt/resolve/Developer/Scripting';
    libDefault = '/opt/resolve/libs/Fusion/fusionscript.so';
    modulesSep = ':';
  }

  const api = base.RESOLVE_SCRIPT_API && base.RESOLVE_SCRIPT_API.trim().length > 0 ? base.RESOLVE_SCRIPT_API : apiDefault;
  const lib = base.RESOLVE_SCRIPT_LIB && base.RESOLVE_SCRIPT_LIB.trim().length > 0 ? base.RESOLVE_SCRIPT_LIB : libDefault;
  const modulesDir = join(api, 'Modules');
  const existingPythonPath = base.PYTHONPATH && base.PYTHONPATH.trim().length > 0 ? base.PYTHONPATH : '';
  const pythonPath = existingPythonPath
    ? `${existingPythonPath}${modulesSep}${modulesDir}`
    : modulesDir;

  return {
    ...base,
    RESOLVE_SCRIPT_API: api,
    RESOLVE_SCRIPT_LIB: lib,
    PYTHONPATH: pythonPath,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Async python execution (G-75 #3 — never execSync on the sidecar's single
// event loop; RPC polls / progress notifications must never stall behind it)
// ─────────────────────────────────────────────────────────────────────────

export interface PythonRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/** Run a python script's SOURCE via stdin (never a temp file, matching the
 *  prior execSync({input}) contract) with an async spawn, a hard timeout,
 *  and a SIGTERM→SIGKILL kill escalation so a wedged/hung interpreter can
 *  never stall the sidecar's stdio event loop. */
export function runPythonScript(
  pyScript: string,
  opts: { timeoutMs: number; env: NodeJS.ProcessEnv; pythonBin?: string },
): Promise<PythonRunResult> {
  return new Promise((resolvePromise) => {
    const pythonBin = opts.pythonBin ?? resolvePythonBin();
    let child: ChildProcess;
    try {
      child = spawn(pythonBin, [], { stdio: ['pipe', 'pipe', 'pipe'], env: opts.env });
    } catch {
      resolvePromise({ stdout: '', stderr: '', code: null, timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // already exited
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already exited
        }
      }, 1500);
    }, opts.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));

    try {
      child.stdin?.write(pyScript);
      child.stdin?.end();
    } catch {
      // stdin already closed / process gone — 'close'/'error' will settle us
    }
  });
}

/**
 * Health check: verify DaVinci Resolve Studio is open and scripting socket
 * is responsive (G-52). Async end-to-end — never blocks the event loop.
 */
export async function checkResolveHealth(): Promise<boolean> {
  const pythonCheck = `
import sys
try:
    import DaVinciResolveScript as dvr
    resolve = dvr.scriptapp("Resolve")
    if resolve:
        sys.exit(0)
    else:
        sys.exit(1)
except Exception:
    sys.exit(1)
`;
  try {
    const result = await runPythonScript(pythonCheck, {
      timeoutMs: 5000,
      env: resolveDaVinciEnv(),
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// FCPXML generation (G-75 #2 — valid resources/ref linkage)
// ─────────────────────────────────────────────────────────────────────────

interface QuantizedClip {
  cell: Cell;
  clipUri: string; // '' when no usable render (renders as a <gap>)
  startMs: number; // absolute clip start in ms — re-quantized at runtime for the live path (G-78)
  startFrame: number;
  durationFrames: number;
}

/** G-53 quantization: every duration is the difference of two absolute
 *  running-total frame boundaries, never a per-cell independent rounding —
 *  the latter drifts a clip's duration out of alignment with the next
 *  clip's offset whenever `duration_ms` doesn't land on a frame boundary. */
function quantizeClips(
  cells: Cell[],
  renders: Map<string, RenderRecord>,
  projectRoot: string,
  fps: number,
): { clips: QuantizedClip[]; totalFrames: number } {
  let currentTimeMs = 0;
  const clips: QuantizedClip[] = [];

  for (const cell of cells) {
    const record = renders.get(cell.uid);
    const rawUri = record?.output?.uri ? resolve(projectRoot, record.output.uri) : '';
    const clipUri = rawUri && existsSync(rawUri) ? rawUri : '';
    const durationMs = cell.duration_ms || 3000;

    const startFrame = msToFrames(currentTimeMs, fps);
    const endFrame = msToFrames(currentTimeMs + durationMs, fps);
    const durationFrames = Math.max(0, endFrame - startFrame);

    clips.push({ cell, clipUri, startMs: currentTimeMs, startFrame, durationFrames });
    currentTimeMs += durationMs;
  }

  return { clips, totalFrames: msToFrames(currentTimeMs, fps) };
}

interface BeatMarker {
  frame: number;
  label: string;
  color: string;
}

function collectMarkers(project: Project, fps: number, enableBeatSync: boolean): BeatMarker[] {
  if (!enableBeatSync || !project.audio_analysis) return [];
  const { downbeats = [], beats = [], onsets = [] } = project.audio_analysis;
  const markers: BeatMarker[] = [];
  for (const ms of downbeats) markers.push({ frame: msToFrames(ms, fps), label: 'Downbeat', color: 'Blue' });
  for (const ms of beats) markers.push({ frame: msToFrames(ms, fps), label: 'Beat', color: 'Purple' });
  for (const ms of onsets) markers.push({ frame: msToFrames(ms, fps), label: 'Transient', color: 'Yellow' });
  markers.sort((a, b) => a.frame - b.frame);
  return markers;
}

/**
 * Generate FCPXML 1.10 representation for DaVinci Resolve import (OTIO
 * fallback). Structurally valid per the FCPXML DTD: one deduped `<asset>`
 * (+ `<media-rep>`) per source file under `<resources>`, every
 * `<asset-clip>` references one via `ref=`, and markers are nested inside
 * the clip whose span covers their absolute time (never bare children of
 * `<spine>`).
 */
export function generateFcpxml(
  cells: Cell[],
  renders: Map<string, RenderRecord>,
  project: Project,
  projectRoot: string,
  fps: number = DEFAULT_FPS,
  enableBeatSync: boolean = true,
): string {
  const { clips, totalFrames } = quantizeClips(cells, renders, projectRoot, fps);
  const markers = collectMarkers(project, fps, enableBeatSync);

  // ── resources: one <asset> per unique source file ──
  const assetIdByUri = new Map<string, string>();
  let nextAssetId = 2; // r1 is the <format>
  for (const clip of clips) {
    if (clip.clipUri && !assetIdByUri.has(clip.clipUri)) {
      assetIdByUri.set(clip.clipUri, `r${nextAssetId++}`);
    }
  }

  let resourceElements = `
    <format id="r1" name="FFVideoFormat1080p${fps}" frameDuration="1/${fps}s" width="1920" height="1080" />`;
  for (const [uri, id] of assetIdByUri) {
    const durationFramesForAsset = clips
      .filter((c) => c.clipUri === uri)
      .reduce((max, c) => Math.max(max, c.durationFrames), 1);
    resourceElements += `
    <asset id="${id}" name="${escapeXmlAttr(uri.split(/[\\/]/).pop() || uri)}" start="0/${fps}s" duration="${durationFramesForAsset}/${fps}s" hasVideo="1" hasAudio="1" format="r1">
      <media-rep kind="original-media" src="${escapeXmlAttr(pathToFileURL(uri).href)}" />
    </asset>`;
  }

  // ── spine: asset-clips (ref=) / gaps, with markers nested by coverage ──
  let spineElements = '';
  for (const clip of clips) {
    const note = `<note>${escapeXmlText(clip.cell.prompt || '')}</note>`;
    if (clip.clipUri) {
      const ref = assetIdByUri.get(clip.clipUri)!;
      const clipEndFrame = clip.startFrame + clip.durationFrames;
      const covering = markers.filter((m) => m.frame >= clip.startFrame && m.frame < clipEndFrame);
      const markerXml = covering
        .map((m) => {
          const localFrame = m.frame - clip.startFrame; // clip-relative (clip's `start` is 0)
          return `
        <marker start="${localFrame}/${fps}s" duration="1/${fps}s" value="${escapeXmlAttr(m.label)}" color="${m.color}" />`;
        })
        .join('');
      spineElements += `
      <asset-clip ref="${ref}" name="${escapeXmlAttr(clip.cell.uid)}" offset="${clip.startFrame}/${fps}s" duration="${clip.durationFrames}/${fps}s" start="0/${fps}s">
        ${note}${markerXml}
      </asset-clip>`;
    } else {
      spineElements += `
      <gap name="${escapeXmlAttr('Gap ' + clip.cell.uid)}" offset="${clip.startFrame}/${fps}s" duration="${clip.durationFrames}/${fps}s" start="0/${fps}s" />`;
    }
  }

  const projectName = escapeXmlAttr(project.title || project.slug || 'Studio Project');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>${resourceElements}
  </resources>
  <library>
    <event name="Ikenga Studio">
      <project name="${projectName}">
        <sequence format="r1" duration="${totalFrames}/${fps}s">
          <spine>
            ${spineElements}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`;
}

/**
 * Live Python script to build and populate DaVinci Resolve Project via API.
 */
export function buildResolvePythonScript(
  cells: Cell[],
  renders: Map<string, RenderRecord>,
  project: Project,
  projectRoot: string,
  timelineName: string,
  fps: number = DEFAULT_FPS,
  enableBeatSync: boolean = true,
): string {
  const { clips } = quantizeClips(cells, renders, projectRoot, fps);

  const clipsPayload = clips.map((clip) => {
    const record = renders.get(clip.cell.uid);
    return {
      uid: clip.cell.uid,
      mediaPath: clip.clipUri || null,
      startMs: clip.startMs,
      startFrame: clip.startFrame,
      durationFrames: clip.durationFrames,
      prompt: clip.cell.prompt || '',
      seed: clip.cell.seed ?? null,
      model: record?.model_id ?? record?.engine ?? '',
    };
  });

  const downbeats = enableBeatSync ? (project.audio_analysis?.downbeats ?? []) : [];
  const beats = enableBeatSync ? (project.audio_analysis?.beats ?? []) : [];
  const onsets = enableBeatSync ? (project.audio_analysis?.onsets ?? []) : [];

  const projectTitleLiteral = pyStringLiteral(project.title || project.slug || 'Ikenga Studio');
  const timelineNameLiteral = pyStringLiteral(timelineName);

  return `
import sys, json, os

try:
    import DaVinciResolveScript as dvr
    resolve = dvr.scriptapp("Resolve")
    if not resolve:
        print(json.dumps({"ok": False, "error": "RESOLVE_NOT_RUNNING"}))
        sys.exit(0)

    pm = resolve.GetProjectManager()
    proj = pm.GetCurrentProject()
    if not proj:
        proj = pm.CreateProject(${projectTitleLiteral})

    mp = proj.GetMediaPool()
    root_folder = mp.GetRootFolder()

    # JSON payloads arrive as Python string literals decoded by json.loads —
    # JSON's null/true/false are NameErrors as bare Python literals (G-77).
    clips_data = json.loads(${pyStringLiteral(JSON.stringify(clipsPayload))})
    downbeats = json.loads(${pyStringLiteral(JSON.stringify(downbeats))})
    beats = json.loads(${pyStringLiteral(JSON.stringify(beats))})
    onsets = json.loads(${pyStringLiteral(JSON.stringify(onsets))})
    fps = ${fps}

    # G-78: markers and record positions are quantized against the LIVE
    # project's actual timeline frame rate, not the caller-requested fps —
    # a 30fps quantization in a 24fps project shifts every marker 25% late.
    proj_fps = None
    try:
        proj_fps = float(proj.GetSetting("timelineFrameRate"))
    except Exception:
        proj_fps = None
    if not proj_fps or proj_fps <= 0:
        proj_fps = fps

    media_items = []
    path_to_item = {}
    for item in clips_data:
        if item["mediaPath"] and os.path.exists(item["mediaPath"]):
            imported = mp.ImportMedia([item["mediaPath"]])
            if imported:
                media_items.extend(imported)
                path_to_item[item["mediaPath"]] = imported[0]

    # G-79 (found live on Resolve 19.1/Windows): AppendToTimeline returns a
    # non-empty list while silently placing nothing. CreateTimelineFromClips
    # both creates the timeline and honors per-clip absolute recordFrame, so
    # it is the primary population path; the old create+append flow stays as
    # the fallback for builds where append works.
    timeline = None
    clip_infos = []

    # CreateTimelineFromClips recordFrame values are ABSOLUTE record frames;
    # learn the project's timeline base first (shared by every timeline in a
    # project). If no timeline exists yet, a throwaway teaches us, then dies.
    base = None
    tl_count = proj.GetTimelineCount() or 0
    if tl_count > 0:
        first = proj.GetTimelineByIndex(1)
        if first:
            base = first.GetStartFrame()
    if base is None:
        probe_tl = mp.CreateEmptyTimeline("__ikenga_base_probe__")
        if probe_tl:
            base = probe_tl.GetStartFrame()
            mp.DeleteTimelines([probe_tl])
    if base is None:
        base = 0

    for item in clips_data:
        media = path_to_item.get(item["mediaPath"])
        if media is None:
            continue
        clip_infos.append({
            "mediaPoolItem": media,
            # Whole-source-clip range: cell renders are exactly duration_ms
            # long by construction, and conformance converts fps. Passing
            # source-range frames computed at the caller's fps would truncate
            # whenever the project frame rate differs.
            "recordFrame": base + round((item["startMs"] / 1000.0) * proj_fps),
        })
    if clip_infos:
        timeline = mp.CreateTimelineFromClips(${timelineNameLiteral}, clip_infos)
    if not timeline:
        timeline = mp.CreateEmptyTimeline(${timelineNameLiteral})
        if timeline:
            if clip_infos:
                mp.AppendToTimeline(clip_infos)
            elif media_items:
                mp.AppendToTimeline(media_items)
    if not timeline:
        timeline = proj.GetCurrentTimeline()
    if not timeline:
        print(json.dumps({"ok": False, "error": "TIMELINE_CREATE_FAILED"}))
        sys.exit(0)

    # Honest population report (G-75 #5 spirit): some builds silently no-op
    # the append fallback; surface what actually landed instead of claiming
    # success on an empty timeline.
    clips_placed = None
    try:
        placed = timeline.GetItemListInTrack("video", 1) or []
        clips_placed = len(placed)
    except Exception:
        clips_placed = None

    # Inject Beat Markers (gated by enableBeatSync — G-75 #7), quantized at
    # the project's runtime frame rate (G-78).
    markers_count = 0
    for db in downbeats:
        frame = round((db / 1000.0) * proj_fps)
        timeline.AddMarker(frame, "Blue", "Downbeat", "Bar start", 1)
        markers_count += 1

    for beat in beats:
        frame = round((beat / 1000.0) * proj_fps)
        timeline.AddMarker(frame, "Purple", "Beat", "Beat", 1)
        markers_count += 1

    for onset in onsets:
        frame = round((onset / 1000.0) * proj_fps)
        timeline.AddMarker(frame, "Yellow", "Transient", "Cut point", 1)
        markers_count += 1

    print(json.dumps({
        "ok": True,
        "timelineName": ${timelineNameLiteral},
        "trackCount": {"video": 1, "audio": 0},
        "markersCount": markers_count,
        "clipsPlaced": clips_placed,
        "frameRate": proj_fps
    }))

except Exception as e:
    print(json.dumps({"ok": False, "error": "SCRIPT_EXCEPTION", "message": str(e)}))
`;
}

/** G-75 #9: resolve `outputPath` against `projectRoot` like `export.compose`
 *  documents ("absolute or project-relative"), falling back to a sanitized
 *  `exportsDir/<timelineName>.fcpxml` when none is given. Pure/exported so
 *  it's directly unit-testable without touching the filesystem. */
export function resolveDavinciOutputPath(opts: {
  outputPath?: string;
  projectRoot: string;
  exportsDir: string;
  timelineName: string;
}): string {
  if (opts.outputPath) {
    return isAbsolute(opts.outputPath) ? opts.outputPath : resolve(opts.projectRoot, opts.outputPath);
  }
  return join(opts.exportsDir, `${sanitizeFilenameComponent(opts.timelineName)}.fcpxml`);
}

/**
 * Primary export entry point for DaVinci Resolve (WP-23).
 */
export async function exportDaVinciTimeline(
  opts: DaVinciExportOptions,
): Promise<DaVinciExportResult> {
  const exportId = randomUUID();
  const fps = opts.fps || DEFAULT_FPS;
  const enableBeatSync = opts.enableBeatSync ?? true;
  const isoStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rawTitle = opts.project.title || opts.project.slug || 'Studio';
  const timelineName = `Ikenga - ${rawTitle} - ${isoStamp}`;

  const exportsDir = join(opts.projectRoot, 'exports');
  mkdirSync(exportsDir, { recursive: true });

  const cells = opts.project.cells ?? [];
  const selectedCells = opts.cellIds
    ? cells.filter((c: Cell) => opts.cellIds?.includes(c.uid))
    : typeof opts.rung === 'number'
      ? cells.filter((c: Cell) => {
          const targetRung = opts.rung === 0 ? '0_beat_sheet' : opts.rung === 1 ? '1_lofi' : '2_hifi';
          return c.rung === targetRung;
        })
      : cells;

  // Collect latest done record for each cell
  const rendersMap = new Map<string, RenderRecord>();
  for (const cell of selectedCells) {
    const doneRecord = (cell.renders || []).slice().reverse().find((r: RenderRecord) => r.status === 'done');
    if (doneRecord) {
      rendersMap.set(cell.uid, doneRecord);
    }
  }

  // 1. Generate XML interchange fallback
  const fcpxml = generateFcpxml(selectedCells, rendersMap, opts.project, opts.projectRoot, fps, enableBeatSync);
  const xmlPath = resolveDavinciOutputPath({
    outputPath: opts.outputPath,
    projectRoot: opts.projectRoot,
    exportsDir,
    timelineName,
  });
  writeFileSync(xmlPath, fcpxml, 'utf-8');

  const markersCount = collectMarkers(opts.project, fps, enableBeatSync).length;

  // 2. Test live DaVinci Resolve connection (G-52)
  const isHealthy = await checkResolveHealth();

  if (isHealthy) {
    // Run live Python export script (async — G-75 #3, never execSync)
    const pyScript = buildResolvePythonScript(
      selectedCells,
      rendersMap,
      opts.project,
      opts.projectRoot,
      timelineName,
      fps,
      enableBeatSync,
    );

    const run = await runPythonScript(pyScript, {
      timeoutMs: 10000,
      env: resolveDaVinciEnv(),
    });

    if (run.code === 0 && !run.timedOut) {
      try {
        const parsed = JSON.parse(run.stdout.trim());
        if (parsed.ok) {
          return {
            ok: true,
            exportId,
            outputPath: xmlPath,
            timelineName: parsed.timelineName,
            trackCount: parsed.trackCount,
            markersCount: parsed.markersCount,
            // G-79/G-78 honest-reporting fields: what actually landed in the
            // live timeline, and the frame rate quantization used.
            ...(parsed.clipsPlaced !== undefined ? { clipsPlaced: parsed.clipsPlaced } : {}),
            ...(parsed.frameRate !== undefined ? { frameRate: parsed.frameRate } : {}),
          };
        }
        // G-75 #5: the script told us definitively that the live export
        // failed — report that honestly rather than silently succeeding
        // on the FCPXML fallback under a "live export succeeded" message.
        return {
          ok: false,
          exportId,
          outputPath: xmlPath,
          error: parsed.error ?? 'SCRIPT_EXCEPTION',
          message: `Live DaVinci Resolve export failed (${parsed.error ?? 'unknown error'}${
            parsed.message ? `: ${parsed.message}` : ''
          }). FCPXML fallback written to ${xmlPath}.`,
        };
      } catch {
        // Script produced non-JSON stdout — couldn't determine a definitive
        // ok/fail verdict from Resolve, so this falls through as an
        // infra-level "live path unavailable", not a reported script
        // failure; the FCPXML fallback is still a legitimate, honest result.
      }
    }
    // Process-level failure (nonzero exit, timeout, spawn error) — same
    // treatment: fall through to the FCPXML-only result below.
  }

  // Return successful file interchange export
  return {
    ok: true,
    exportId,
    outputPath: xmlPath,
    timelineName,
    trackCount: { video: 1, audio: 0 },
    markersCount,
    message: isHealthy
      ? 'Live DaVinci Resolve export could not be confirmed; exported FCPXML/OTIO interchange file ready for import.'
      : 'DaVinci Resolve not running; exported FCPXML/OTIO interchange file ready for import.',
  };
}
