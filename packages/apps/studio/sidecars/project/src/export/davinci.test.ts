// com.ikenga.studio project sidecar · davinci.ts DaVinci Resolve exporter (G-75)
//
//   bun run src/export/davinci.test.ts   (from sidecars/project/)
//   bun run test                          (package script — runs this + the others)
//
// Plain assert-based script (no bun:test / node:test import) — same rationale
// as the other sidecar *.test.ts files: this typechecks under the shared
// `tsc -p ../../tsconfig.json` project (no Bun types) while running for real
// under the bun runtime.
//
// Covers everything testable WITHOUT a DaVinci Resolve install or a real
// python interpreter: FCPXML structural validity (resources/ref linkage +
// marker nesting, G-75 #2), the G-53 boundary-quantization drift fix
// (G-75 #6), enableBeatSync marker gating + the third beats[] marker color
// (G-75 #7/#8), and XML/Python/filename escaping (G-75 #9). The RPC
// reachability fix (G-75 #1) is covered separately by rpc.dispatch.test.ts
// since it's a dispatcher-wiring concern, not a davinci.ts one.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildResolvePythonScript,
  escapeXmlAttr,
  generateFcpxml,
  msToFrames,
  pyStringLiteral,
  resolveDavinciOutputPath,
  sanitizeFilenameComponent,
} from './davinci.js';
import type { Cell, Project, RenderRecord } from '@ikenga/studio-schema';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Minimal fixtures
// ─────────────────────────────────────────────────────────────────────────

function fakeCell(overrides: Partial<Cell> = {}): Cell {
  return {
    uid: 'cell-1',
    beat_id: 'beat-1',
    rung: '2_hifi',
    duration_ms: 3000,
    prompt: 'a shot',
    anchors: [],
    renders: [],
    metadata: {},
    ...overrides,
  } as never;
}

function fakeRecord(uri: string, overrides: Partial<RenderRecord> = {}): RenderRecord {
  return {
    id: 'rec-1',
    cell_uid: 'cell-1',
    engine: 'hyperframes',
    status: 'done',
    output: { uri },
    ...overrides,
  } as never;
}

function fakeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    slug: 'proj-1',
    title: 'My Project',
    archetype_id: 'music-video',
    cells: [],
    ...overrides,
  } as never;
}

// ─────────────────────────────────────────────────────────────────────────
// Structural XML "parser" — good enough to prove resources/ref linkage and
// marker nesting without pulling in an XML dependency. Deliberately narrow:
// it only extracts what these assertions need.
// ─────────────────────────────────────────────────────────────────────────

function extractResourcesBlock(xml: string): string {
  const m = xml.match(/<resources>([\s\S]*?)<\/resources>/);
  assert.ok(m, 'must have a <resources> block');
  return m![1];
}

function extractSpineBlock(xml: string): string {
  const m = xml.match(/<spine>([\s\S]*?)<\/spine>/);
  assert.ok(m, 'must have a <spine> block');
  return m![1];
}

function allAttrValues(xml: string, tag: string, attr: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]*)"`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

async function main(): Promise<number> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'davinci-test-'));
  const videoA = join(tmpDir, 'a.mp4');
  const videoB = join(tmpDir, 'b.mp4');
  writeFileSync(videoA, 'fake-mp4-a');
  writeFileSync(videoB, 'fake-mp4-b');

  try {
    // ── G-75 #2: FCPXML resources/ref linkage ─────────────────────────────
    test('generateFcpxml: every asset-clip ref= resolves to a declared <asset id=>', () => {
      const cells = [
        fakeCell({ uid: 'c1', duration_ms: 1000 }),
        fakeCell({ uid: 'c2', duration_ms: 1000 }),
      ];
      const renders = new Map<string, RenderRecord>([
        ['c1', fakeRecord(videoA)],
        ['c2', fakeRecord(videoB)],
      ]);
      const xml = generateFcpxml(cells, renders, fakeProject(), tmpDir, 30, false);

      const resources = extractResourcesBlock(xml);
      const assetIds = allAttrValues(resources, 'asset', 'id');
      assert.equal(assetIds.length, 2, `expected 2 declared assets, got: ${assetIds.join(',')}`);
      assert.ok(new Set(assetIds).size === assetIds.length, 'asset ids must be unique');

      const spine = extractSpineBlock(xml);
      const refs = allAttrValues(spine, 'asset-clip', 'ref');
      assert.equal(refs.length, 2, 'both cells produced an asset-clip (both have on-disk renders)');
      for (const ref of refs) {
        assert.ok(assetIds.includes(ref), `asset-clip ref="${ref}" must match a declared <asset id="...">`);
      }
      // No bare `src=` on asset-clip — that's not a valid DTD attribute there.
      assert.doesNotMatch(spine, /<asset-clip[^>]*\bsrc=/, 'asset-clip must never carry a bare src=');
      // Every declared asset carries a <media-rep> with the actual file src.
      assert.match(resources, /<media-rep kind="original-media" src="file:\/\//);
    });

    test('generateFcpxml: same source file used twice dedupes to one <asset>', () => {
      const cells = [
        fakeCell({ uid: 'c1', duration_ms: 1000 }),
        fakeCell({ uid: 'c2', duration_ms: 1000 }),
      ];
      const renders = new Map<string, RenderRecord>([
        ['c1', fakeRecord(videoA)],
        ['c2', fakeRecord(videoA)], // same file
      ]);
      const xml = generateFcpxml(cells, renders, fakeProject(), tmpDir, 30, false);
      const assetIds = allAttrValues(extractResourcesBlock(xml), 'asset', 'id');
      assert.equal(assetIds.length, 1, 'identical source files must dedupe to a single <asset>');
      const refs = allAttrValues(extractSpineBlock(xml), 'asset-clip', 'ref');
      assert.equal(refs.length, 2);
      assert.equal(refs[0], refs[1], 'both clips reference the same deduped asset id');
    });

    test('generateFcpxml: a cell with no on-disk render falls back to a <gap>, not a dangling ref', () => {
      const cells = [fakeCell({ uid: 'c1', duration_ms: 1000 })];
      const renders = new Map<string, RenderRecord>([['c1', fakeRecord(join(tmpDir, 'missing.mp4'))]]);
      const xml = generateFcpxml(cells, renders, fakeProject(), tmpDir, 30, false);
      const spine = extractSpineBlock(xml);
      assert.match(spine, /<gap /);
      assert.doesNotMatch(spine, /<asset-clip/);
    });

    // ── G-75 #2 continued: markers are nested inside clips, never bare
    //    children of <spine> ──────────────────────────────────────────────
    test('generateFcpxml: markers are nested inside their covering <asset-clip>, not direct <spine> children', () => {
      const cells = [fakeCell({ uid: 'c1', duration_ms: 2000 })];
      const renders = new Map<string, RenderRecord>([['c1', fakeRecord(videoA)]]);
      const project = fakeProject({
        audio_analysis: { bpm: 120, downbeats: [500], beats: [], onsets: [] },
      } as never);
      const xml = generateFcpxml(cells, renders, project, tmpDir, 30, true);

      const spine = extractSpineBlock(xml);
      // A marker directly under <spine> (sibling of asset-clip, not inside
      // it) would show up right after the spine's own opening whitespace —
      // assert it never appears OUTSIDE an asset-clip element by checking
      // the marker is only found between an <asset-clip ...> and its </asset-clip>.
      const clipMatch = spine.match(/<asset-clip[^]*?<\/asset-clip>/);
      assert.ok(clipMatch, 'expected one asset-clip element');
      assert.match(clipMatch![0], /<marker /, 'marker must be nested inside the asset-clip');

      // Strip the clip's own content and confirm no orphan <marker> remains
      // as a direct sibling in the rest of the spine.
      const spineWithoutClip = spine.replace(clipMatch![0], '');
      assert.doesNotMatch(spineWithoutClip, /<marker /);
    });

    // ── G-75 #6: G-53 boundary quantization (no cumulative drift) ─────────
    test('generateFcpxml: 3+ cells whose durations do not land on frame boundaries stay boundary-aligned (no gap/overlap)', () => {
      const fps = 30;
      // 1016ms @ 30fps = 30.48 frames — rounds to 30 if quantized per-cell in
      // isolation, but the running total drifts: cumulative totals are
      // 1016, 2032, 3048ms → frames 30.48, 60.96, 91.44 → round to 30, 61, 91.
      const durationsMs = [1016, 1016, 1016];
      const cells = durationsMs.map((ms, i) => fakeCell({ uid: `c${i}`, duration_ms: ms }));
      const renders = new Map<string, RenderRecord>(
        cells.map((c) => [c.uid, fakeRecord(videoA)] as [string, RenderRecord]),
      );
      const xml = generateFcpxml(cells, renders, fakeProject(), tmpDir, fps, false);
      const spine = extractSpineBlock(xml);

      const offsets = allAttrValues(spine, 'asset-clip', 'offset').map((v) => parseInt(v.split('/')[0], 10));
      const durations = allAttrValues(spine, 'asset-clip', 'duration').map((v) => parseInt(v.split('/')[0], 10));
      assert.equal(offsets.length, 3);

      // Boundary alignment: offset[i+1] must exactly equal offset[i] + duration[i].
      for (let i = 0; i < offsets.length - 1; i++) {
        assert.equal(
          offsets[i + 1],
          offsets[i] + durations[i],
          `clip ${i + 1}'s offset (${offsets[i + 1]}) must equal clip ${i}'s offset+duration (${offsets[i] + durations[i]}) — a gap/overlap means per-cell rounding drifted`,
        );
      }
      // And the naive (wrong) per-cell-independent rounding would have given
      // 30 frames for every cell (round(1016/1000*30) = 30) — prove we did
      // NOT do that for all three, i.e. boundary math actually kicked in.
      assert.notDeepEqual(durations, [30, 30, 30], 'expected boundary-derived durations, not per-cell msToFrames(duration)');
    });

    // ── G-75 #7/#8: enableBeatSync gates markers; beats[] gets a 3rd label/color ─
    test('generateFcpxml: enableBeatSync=false suppresses all markers', () => {
      const cells = [fakeCell({ uid: 'c1', duration_ms: 3000 })];
      const renders = new Map<string, RenderRecord>([['c1', fakeRecord(videoA)]]);
      const project = fakeProject({
        audio_analysis: { bpm: 120, downbeats: [100], beats: [200], onsets: [300] },
      } as never);
      const xml = generateFcpxml(cells, renders, project, tmpDir, 30, false);
      assert.doesNotMatch(xml, /<marker /);
    });

    test('generateFcpxml: downbeats/beats/onsets get three distinct labels+colors', () => {
      const cells = [fakeCell({ uid: 'c1', duration_ms: 3000 })];
      const renders = new Map<string, RenderRecord>([['c1', fakeRecord(videoA)]]);
      const project = fakeProject({
        audio_analysis: { bpm: 120, downbeats: [100], beats: [200], onsets: [300] },
      } as never);
      const xml = generateFcpxml(cells, renders, project, tmpDir, 30, true);

      assert.match(xml, /value="Downbeat" color="Blue"/);
      assert.match(xml, /value="Beat" color="Purple"/);
      assert.match(xml, /value="Transient" color="Yellow"/);
      // All three colors must be distinct from one another.
      const colors = new Set(['Blue', 'Purple', 'Yellow']);
      assert.equal(colors.size, 3);
    });

    // ── G-75 #9: escaping ──────────────────────────────────────────────────
    test('escapeXmlAttr: quotes/ampersands/angle-brackets are all escaped', () => {
      const escaped = escapeXmlAttr(`Say "hi" & <bye> 'quote'`);
      assert.doesNotMatch(escaped, /"/);
      assert.doesNotMatch(escaped, /</);
      assert.doesNotMatch(escaped, />/);
      assert.match(escaped, /&quot;/);
      assert.match(escaped, /&amp;/);
    });

    test('generateFcpxml: a project title with a double quote never breaks the XML attribute', () => {
      const cells = [fakeCell({ uid: 'c1', duration_ms: 1000 })];
      const renders = new Map<string, RenderRecord>([['c1', fakeRecord(videoA)]]);
      const project = fakeProject({ title: `My "Great" Project & Friends <2>` });
      const xml = generateFcpxml(cells, renders, project, tmpDir, 30, false);
      // The raw quote must not appear un-escaped inside the project name attribute.
      const nameMatch = xml.match(/<project name="([^]*?)">/);
      assert.ok(nameMatch);
      assert.doesNotMatch(nameMatch![1], /"/);
      assert.match(xml, /My &quot;Great&quot; Project &amp; Friends &lt;2&gt;/);
    });

    test('pyStringLiteral: embeds a title with quotes/backslashes as a safe Python string literal', () => {
      const literal = pyStringLiteral(`He said "hi" \\ backslash`);
      assert.ok(literal.startsWith('"') && literal.endsWith('"'));
      // JSON.stringify escapes both the embedded quote and the backslash.
      assert.match(literal, /\\"/);
      assert.match(literal, /\\\\/);
    });

    test('sanitizeFilenameComponent: strips path separators and colons from a title-derived filename', () => {
      const s = sanitizeFilenameComponent('My/Weird:Title*With?Chars');
      assert.doesNotMatch(s, /[\\/:*?"<>|]/);
    });

    // ── G-77: JSON payloads must be json.loads-wrapped Python literals ─────
    // JSON.stringify output interpolated bare into Python source is invalid
    // Python (null/true/false are NameErrors). Found live 2026-09-11: every
    // unseeded cell's `seed: null` crashed the generated script with
    // `name 'null' is not defined` the moment Resolve was actually running.
    test('buildResolvePythonScript: payload interpolations are json.loads string literals, never bare JSON (G-77)', () => {
      const cells = [fakeCell({ uid: 'c1', duration_ms: 1000 })]; // seed unset → payload contains JSON null
      const renders = new Map<string, RenderRecord>([['c1', fakeRecord(videoA)]]);
      const project = fakeProject({
        audio_analysis: { bpm: 120, downbeats: [0], beats: [500], onsets: [250] },
      } as never);
      const script = buildResolvePythonScript(cells, renders, project, tmpDir, 'TL G77', 30, true);
      for (const v of ['clips_data', 'downbeats', 'beats', 'onsets']) {
        assert.match(
          script,
          new RegExp(`${v} = json\\.loads\\("`),
          `${v} must decode from a json.loads string literal`,
        );
        assert.doesNotMatch(
          script,
          new RegExp(`${v} = \\[`),
          `${v} must never be a bare interpolated JSON literal`,
        );
      }
      // The G-77 crash signature — a bare JSON object/array emitted as Python.
      assert.doesNotMatch(script, /clips_data = \[\{/, 'JSON.stringify payload leaked bare into Python');
    });

    test('buildResolvePythonScript: null seed / missing model survive the round-trip through json.loads', () => {
      const cells = [fakeCell({ uid: 'c1', duration_ms: 1000 })];
      const renders = new Map<string, RenderRecord>([['c1', fakeRecord(videoA)]]);
      const project = fakeProject();
      const script = buildResolvePythonScript(cells, renders, project, tmpDir, 'TL', 30, true);
      // The clips payload line must be a single well-formed json.loads(...) call
      // whose argument is a double-quoted Python string literal (JSON string
      // syntax is a subset of Python's), so json.loads can decode it 1:1.
      const m = script.match(/clips_data = json\.loads\("(?:[^"\\]|\\.)*"\)/);
      assert.ok(m, 'clips_data payload must be a quoted string literal');
      // The unseeded cell renders `seed: null` inside that literal — allowed
      // there (escaped as \" inside the Python string), decoded to Python
      // None at runtime.
      assert.match(m![0], /\\?"seed\\?":null/);
    });

    // ── G-79: CreateTimelineFromClips is the primary population path ──────
    // Found live on Resolve 19.1/Windows: AppendToTimeline returns a
    // non-empty list while silently placing nothing (UI shows "0 Clip").
    test('buildResolvePythonScript: populates via CreateTimelineFromClips with an absolute-recordFrame base probe, AppendToTimeline only as fallback (G-79)', () => {
      const cells = [fakeCell({ uid: 'c1', duration_ms: 1000 })];
      const renders = new Map<string, RenderRecord>([['c1', fakeRecord(videoA)]]);
      const script = buildResolvePythonScript(cells, renders, fakeProject(), tmpDir, 'TL', 30, true);
      // Primary: CTFC with clip_infos built from a learned base.
      assert.match(script, /timeline = mp\.CreateTimelineFromClips\(/, 'CreateTimelineFromClips must be the primary population path');
      // Base learning: existing timeline first, then a throwaway probe.
      assert.match(script, /GetTimelineByIndex\(1\)/);
      assert.match(script, /__ikenga_base_probe__/);
      assert.match(script, /mp\.DeleteTimelines\(\[probe_tl\]\)/);
      // Fallback kept for builds where append works — but AFTER CTFC.
      const ctfcAt = script.indexOf('CreateTimelineFromClips');
      const appendAt = script.indexOf('mp.AppendToTimeline(');
      assert.ok(ctfcAt > -1 && appendAt > -1 && ctfcAt < appendAt, 'CTFC must precede the AppendToTimeline fallback');
      // A None timeline is reported honestly, never crashed into (G-75 #5 spirit).
      assert.match(script, /TIMELINE_CREATE_FAILED/);
    });

    // ── G-78: live quantization uses the project's runtime frame rate ─────
    // Found live: the caller's fps (30) quantized markers into a 24fps
    // project timeline — every marker landed 25% late in wall-clock time.
    test('buildResolvePythonScript: reads timelineFrameRate at runtime and quantizes markers/record positions with it (G-78)', () => {
      const cells = [fakeCell({ uid: 'c1', duration_ms: 1000 })];
      const renders = new Map<string, RenderRecord>([['c1', fakeRecord(videoA)]]);
      const project = fakeProject({
        audio_analysis: { bpm: 120, downbeats: [0], beats: [500], onsets: [250] },
      } as never);
      const script = buildResolvePythonScript(cells, renders, project, tmpDir, 'TL', 30, true);
      assert.match(script, /GetSetting\("timelineFrameRate"\)/);
      // Marker frames are computed from proj_fps, never the caller fps.
      assert.match(script, /round\(\(db \/ 1000\.0\) \* proj_fps\)/);
      assert.match(script, /round\(\(beat \/ 1000\.0\) \* proj_fps\)/);
      assert.match(script, /round\(\(onset \/ 1000\.0\) \* proj_fps\)/);
      // Record positions are base + ms quantized at the runtime fps.
      assert.match(script, /base \+ round\(\(item\["startMs"\] \/ 1000\.0\) \* proj_fps\)/);
      // The payload carries absolute startMs so the runtime fps can be applied
      // (escaped as \" inside the json.loads string literal).
      assert.match(script, /\\?"startMs\\?":0/);
      // Success reports the effective frame rate and what actually landed.
      assert.match(script, /"clipsPlaced": clips_placed/);
      assert.match(script, /"frameRate": proj_fps/);
      // And does NOT quantize markers at the caller fps anymore.
      assert.doesNotMatch(script, /round\(\(db \/ 1000\.0\) \* fps\)/);
    });

    // ── outputPath resolution mirrors export.compose (G-75 #9) ────────────
    const projectRoot = process.platform === 'win32' ? 'C:\\proj\\root' : '/proj/root';
    const exportsDir = join(projectRoot, 'exports');

    test('resolveDavinciOutputPath: relative outputPath resolves against projectRoot', () => {
      const p = resolveDavinciOutputPath({
        outputPath: join('custom', 'out.fcpxml'),
        projectRoot,
        exportsDir,
        timelineName: 'Timeline A',
      });
      assert.equal(p, join(projectRoot, 'custom', 'out.fcpxml'));
    });

    test('resolveDavinciOutputPath: absolute outputPath passes through unchanged', () => {
      const abs = process.platform === 'win32' ? 'C:\\elsewhere\\out.fcpxml' : '/elsewhere/out.fcpxml';
      const p = resolveDavinciOutputPath({
        outputPath: abs,
        projectRoot,
        exportsDir,
        timelineName: 'Timeline A',
      });
      assert.equal(p, abs);
    });

    test('resolveDavinciOutputPath: no outputPath falls back to a sanitized exportsDir/<timelineName>.fcpxml', () => {
      const p = resolveDavinciOutputPath({
        projectRoot,
        exportsDir,
        timelineName: 'Weird/Name:With*Chars',
      });
      assert.ok(p.startsWith(exportsDir));
      assert.ok(p.endsWith('.fcpxml'));
      const filename = p.slice(exportsDir.length).replace(/^[\\/]/, '');
      assert.doesNotMatch(filename, /[\\/:*?"<>|]/);
    });

    // ── msToFrames sanity (unchanged helper, still lifted verbatim behavior) ─
    test('msToFrames: rounds to nearest frame at 30fps', () => {
      assert.equal(msToFrames(1016, 30), 30); // 30.48 → 30
      assert.equal(msToFrames(2032, 30), 61); // 60.96 → 61
    });

    console.log(`\n${passed} passed`);
    return 0;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

process.exit(await main());
