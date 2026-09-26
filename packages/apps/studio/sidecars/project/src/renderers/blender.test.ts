// com.ikenga.studio project sidecar · blender.ts renderer adapter (G-74)
//
//   bun run src/renderers/blender.test.ts   (from sidecars/project/)
//   bun run test                             (package script — runs this + the others)
//
// Plain assert-based script (no bun:test / node:test import) — same rationale
// as registry.test.ts / session.test.ts / storyboard.test.ts / recents.test.ts:
// this file typechecks under the shared `tsc -p ../../tsconfig.json` project,
// which has no Bun types, while still running for real under the bun runtime.
//
// There is no Blender binary on this toolchain-less box, so this proves
// everything that's testable WITHOUT spawning Blender: argv construction
// (the G-74 #2 arg-order fix), output-path derivation (the G-74 #1 fix —
// never a frame-range-suffixed name), the frame-count/resolution math behind
// the G-74 #4/#6 fixes, the progress-line parser, and the pre-aborted bail
// (G-74 #5) which — by construction — never touches resolveBlenderPath or
// spawns anything, so it needs no binary either.

import assert from 'node:assert/strict';

import {
  blenderAdapter,
  blenderOutputPath,
  buildBaseArgs,
  buildPreviewArgs,
  buildRenderArgs,
  buildResolutionExpr,
  buildDeviceExpr,
  buildDeviceProbeScript,
  compareVersionsDesc,
  computeTotalFrames,
  discoverVersionedBlender,
  ffmpegPatternFromBlender,
  PLATE_OK_SENTINEL,
  parseDeviceFromChunk,
  parseFrameFromChunk,
  parseProbeDevice,
  scalePadFilter,
} from './blender.js';
import type { RenderContext } from './types.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

function fakeCtx(overrides: Partial<RenderContext> = {}): RenderContext {
  const controller = new AbortController();
  return {
    projectRoot: '/proj',
    cellDir: '/proj/cells/hifi/c1',
    rendersDir: '/proj/renders',
    aspectRatio: '16:9',
    resolution: { w: 1920, h: 1080 },
    vault: { get: async () => undefined },
    emit: () => {},
    signal: controller.signal,
    ...overrides,
  };
}

async function main(): Promise<number> {
  // ── G-74 #1: output-path derivation never yields a frame-range name ────
  test('blenderOutputPath lands at <rendersDir>/blender/<rungDir>/<uid>.mp4 (no frame suffix)', () => {
    const { outDir, outPath } = blenderOutputPath('/proj/renders', {
      uid: 'shot-01',
      rung: '2_hifi',
    } as never);
    assert.ok(outDir.replace(/\\/g, '/').endsWith('/renders/blender/hifi'));
    assert.equal(outPath.replace(/\\/g, '/'), `${outDir.replace(/\\/g, '/')}/shot-01.mp4`);
    // Must be an exact, discoverable filename — never `_####`, `_0001-0090`,
    // or any other frame-range/frame-number suffix a naive rename-after-glob
    // strategy could leave behind.
    assert.doesNotMatch(outPath, /#|\d{4}-\d{4}/);
  });

  // ── G-74 #2: preview() argv puts -o/-F before the -f trigger ───────────
  test('buildPreviewArgs: -o and -F precede -f (the render trigger)', () => {
    const args = buildPreviewArgs('/proj/cells/c1/scene.blend', { w: 1920, h: 1080 }, '/out/prefix_####');
    const oIdx = args.indexOf('-o');
    const fIdx = args.indexOf('-f');
    assert.ok(oIdx >= 0 && fIdx >= 0, 'both -o and -f must be present');
    assert.ok(oIdx < fIdx, `-o (${oIdx}) must precede -f (${fIdx}): ${args.join(' ')}`);
    assert.ok(args.indexOf('-F') < fIdx, '-F must precede -f');
    assert.deepEqual(args.slice(oIdx), ['-o', '/out/prefix_####', '-F', 'PNG', '-x', '1', '-f', '1']);
  });

  test('buildPreviewArgs: no "--" sys.argv separator (Blender itself must parse -o/-F/-f)', () => {
    const args = buildPreviewArgs('/proj/cells/c1/scene.blend', { w: 1920, h: 1080 }, '/out/prefix_####');
    assert.ok(!args.includes('--'), `unexpected "--" separator: ${args.join(' ')}`);
  });

  // ── G-74 #2: render() argv puts output/range flags before the -a trigger ─
  test('buildRenderArgs: -o/-F/-s/-e precede -a (the animation trigger)', () => {
    const args = buildRenderArgs('/proj/cells/c1/scene.blend', { w: 1920, h: 1080 }, '/scratch/frame_####.png', 90);
    const aIdx = args.indexOf('-a');
    assert.ok(aIdx >= 0);
    for (const flag of ['-o', '-F', '-x', '-s', '-e']) {
      const idx = args.indexOf(flag);
      assert.ok(idx >= 0 && idx < aIdx, `${flag} (${idx}) must precede -a (${aIdx}): ${args.join(' ')}`);
    }
    // Renders a PNG sequence, never Blender's own FFMPEG movie muxer (the
    // strategy this adapter deliberately did NOT take — see file header).
    assert.equal(args[args.indexOf('-F') + 1], 'PNG');
    assert.ok(!args.includes('FFMPEG'));
  });

  test('buildRenderArgs: frame range is 1..totalFrames', () => {
    const args = buildRenderArgs('/proj/cells/c1/scene.blend', { w: 1920, h: 1080 }, '/scratch/frame_####.png', 42);
    assert.equal(args[args.indexOf('-s') + 1], '1');
    assert.equal(args[args.indexOf('-e') + 1], '42');
  });

  // ── content-type dispatch (.blend vs .py) feeding into buildBaseArgs ───
  test('buildBaseArgs: .blend files are passed positionally', () => {
    const args = buildBaseArgs('/proj/cells/c1/scene.blend', { w: 100, h: 100 });
    assert.ok(args.includes('/proj/cells/c1/scene.blend'));
    assert.ok(!args.includes('--python'));
  });

  test('buildBaseArgs: .py files load via --python (not the "--" sys.argv side channel)', () => {
    const args = buildBaseArgs('/proj/cells/c1/scene.py', { w: 100, h: 100 });
    const pyIdx = args.indexOf('--python');
    assert.ok(pyIdx >= 0);
    assert.equal(args[pyIdx + 1], '/proj/cells/c1/scene.py');
    assert.ok(!args.includes('--'), 'the .py path must not rely on the sys.argv "--" side channel any more');
  });

  // ── G-74 #6: capabilities honesty — resolution is actually injected ────
  test('buildResolutionExpr: sets resolution_x/y + resolution_percentage=100', () => {
    const expr = buildResolutionExpr(1080, 1920);
    assert.match(expr, /resolution_x = 1080/);
    assert.match(expr, /resolution_y = 1920/);
    assert.match(expr, /resolution_percentage = 100/);
  });

  test('buildBaseArgs: injects --python-expr resolution setup before any output flag would be appended', () => {
    const args = buildBaseArgs('/proj/cells/c1/scene.blend', { w: 720, h: 1280 });
    const exprIdx = args.indexOf('--python-expr');
    assert.ok(exprIdx >= 0);
    assert.match(args[exprIdx + 1]!, /resolution_x = 720/);
    assert.match(args[exprIdx + 1]!, /resolution_y = 1280/);
  });

  test('render() argv threads a non-default resolution end to end', () => {
    const args = buildRenderArgs('/proj/cells/c1/scene.blend', { w: 1080, h: 1920 }, '/scratch/frame_####.png', 10);
    const exprIdx = args.indexOf('--python-expr');
    assert.match(args[exprIdx + 1]!, /resolution_x = 1080/);
    assert.match(args[exprIdx + 1]!, /resolution_y = 1920/);
  });

  // ── G-74 #4: fps model is 30, not the old 24fps fallback ───────────────
  test('computeTotalFrames: uses 30fps (frozen P1 time model), not 24fps', () => {
    assert.equal(computeTotalFrames(3000), 90); // 3s @ 30fps
    assert.equal(computeTotalFrames(1000), 30); // 1s @ 30fps — would be 24 under the old fallback
  });

  test('computeTotalFrames: falls back to a 3s default and floors at 1 frame', () => {
    assert.equal(computeTotalFrames(undefined), 90);
    assert.equal(computeTotalFrames(0), 90); // `0 || 3000` — matches the pre-existing fallback semantics
    assert.equal(computeTotalFrames(1), 1); // rounds down to 0 frames, floored to 1
  });

  // ── progress envelope shape: { recordId, cellId, engine, progress, frame } ─
  test('progress envelope matches hyperframes.ts / excalidraw.ts / fal.ts shape', () => {
    const emitted: unknown[] = [];
    const ctx = fakeCtx({ emit: (e) => emitted.push(e) });
    ctx.emit({
      type: 'render.progress',
      payload: { recordId: 'r1', cellId: 'c1', engine: 'blender', progress: 0.5, frame: 45 },
    });
    const evt = emitted[0] as { type: string; payload: Record<string, unknown> };
    assert.equal(evt.type, 'render.progress');
    assert.deepEqual(Object.keys(evt.payload).sort(), ['cellId', 'engine', 'frame', 'progress', 'recordId']);
    assert.equal(evt.payload.engine, 'blender');
  });

  // ── stdout frame-progress parsing ───────────────────────────────────────
  test('parseFrameFromChunk: parses "Fra:N" out of Blender stdout', () => {
    assert.equal(parseFrameFromChunk('Fra:12 Mem:16.83M (Peak 16.83M) | Rendering'), 12);
    assert.equal(parseFrameFromChunk('fra:7'), 7); // case-insensitive
    assert.equal(parseFrameFromChunk('Saved: /tmp/frame_0003.png'), null);
    assert.equal(parseFrameFromChunk(''), null);
  });

  // ── ffmpeg assembly filter parity with excalidraw.ts ────────────────────
  test('scalePadFilter matches the scale+pad+format shape used to assemble frames', () => {
    const f = scalePadFilter(1920, 1080);
    assert.match(f, /^scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080/);
    assert.match(f, /format=yuv420p$/);
  });

  // ── G-74 #5: pre-aborted bail before any spawn/vault lookup ─────────────
  await testAsync('render(): bails synchronously-ish on an already-aborted signal, never touching the vault', async () => {
    const controller = new AbortController();
    controller.abort();
    let vaultCalled = false;
    const ctx = fakeCtx({
      signal: controller.signal,
      vault: { get: async () => { vaultCalled = true; return undefined; } },
    });
    const cell = {
      uid: 'c1',
      rung: '2_hifi',
      content_path: 'cells/hifi/c1/scene.blend',
      duration_ms: 3000,
      anchors: [],
      metadata: {},
    } as never;

    await assert.rejects(
      () => blenderAdapter.render(cell, {}, ctx),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as Error & { cancelled?: boolean }).cancelled, true);
        return true;
      },
    );
    assert.equal(vaultCalled, false, 'render() must bail before resolving the Blender binary at all');
  });

  await testAsync('preview(): bails synchronously-ish on an already-aborted signal, never touching the vault', async () => {
    const controller = new AbortController();
    controller.abort();
    let vaultCalled = false;
    const ctx = fakeCtx({
      signal: controller.signal,
      vault: { get: async () => { vaultCalled = true; return undefined; } },
    });
    const cell = {
      uid: 'c1',
      rung: '2_hifi',
      content_path: 'cells/hifi/c1/scene.blend',
      duration_ms: 3000,
      anchors: [],
      metadata: {},
    } as never;

    await assert.rejects(
      () => blenderAdapter.preview(cell, ctx),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as Error & { cancelled?: boolean }).cancelled, true);
        return true;
      },
    );
    assert.equal(vaultCalled, false, 'preview() must bail before resolving the Blender binary at all');
  });

  // ── cancel(recordId) on an unknown id is a safe no-op ───────────────────
  await testAsync('cancel(): unknown recordId is a no-op (never throws)', async () => {
    await blenderAdapter.cancel!('does-not-exist');
  });

  // ── G-BL-GPU: compute-device selection ─────────────────────────────────
  // The adapter shipped without ANY device selection, so Cycles fell back to
  // CPU on every render while the GPU idled (~4x slower, no error). These
  // pin the fix's contract.

  test('buildDeviceExpr: GPU backend sets compute_device_type and scene device', () => {
    const expr = buildDeviceExpr('CUDA');
    assert.match(expr, /compute_device_type = 'CUDA'/);
    assert.match(expr, /get_devices\(\)/);
    assert.match(expr, /cycles\.device = 'GPU'/);
  });

  test('buildDeviceExpr: get_devices() is called AFTER compute_device_type is set', () => {
    const expr = buildDeviceExpr('OPTIX');
    assert.ok(
      expr.indexOf('compute_device_type') < expr.indexOf('get_devices()'),
      'get_devices() populates .devices for the selected backend — order matters',
    );
  });

  test('buildDeviceExpr: CPU pins CPU and never touches the GPU prefs', () => {
    const expr = buildDeviceExpr('CPU');
    assert.match(expr, /cycles\.device = 'CPU'/);
    assert.ok(!expr.includes('compute_device_type'));
  });

  test('buildDeviceExpr: defaults to CPU when no device is resolved', () => {
    assert.equal(buildDeviceExpr(), buildDeviceExpr('CPU'));
  });

  test('buildDeviceExpr: never sets render.engine (G-BL-ENUM — the .blend decides)', () => {
    // Plan 24 typed BLENDER_EEVEE_NEXT, which does not exist in Blender 5.x.
    // The adapter sidesteps the whole question by leaving the engine alone.
    for (const d of ['OPTIX', 'CUDA', 'CPU'] as const) {
      assert.ok(!buildDeviceExpr(d).includes('render.engine'));
      assert.ok(!buildDeviceExpr(d).includes('EEVEE'));
    }
  });

  test('buildDeviceExpr: is wrapped so a Cycles-less build cannot fail the render', () => {
    for (const d of ['OPTIX', 'CUDA', 'CPU'] as const) {
      assert.match(buildDeviceExpr(d), /^try:/);
      assert.match(buildDeviceExpr(d), /except Exception/);
    }
  });

  test('buildBaseArgs: composes resolution + device into ONE --python-expr', () => {
    const args = buildBaseArgs('/proj/cells/c1/scene.blend', { w: 1920, h: 1080 }, 'CUDA');
    assert.equal(
      args.filter((a) => a === '--python-expr').length,
      1,
      'a second --python-expr would break the arg-order contract the G-74 tests pin',
    );
    const expr = args[args.indexOf('--python-expr') + 1]!;
    assert.match(expr, /resolution_x = 1920/);
    assert.match(expr, /compute_device_type = 'CUDA'/);
    assert.ok(expr.indexOf('import bpy') === 0, 'resolution expr must lead — it emits the import');
  });

  test('parseDeviceFromChunk: reads the device marker, ignores unrelated stdout', () => {
    assert.equal(parseDeviceFromChunk('[studio] cycles_device=CUDA\n'), 'CUDA');
    assert.equal(parseDeviceFromChunk('Fra:12 Mem:40.00M | Sample 4/48'), null);
  });

  test('parseDeviceFromChunk: device marker does not collide with Fra: progress grammar', () => {
    assert.equal(parseFrameFromChunk('[studio] cycles_device=OPTIX\n'), null);
  });

  // The probe exists because enumeration is NOT a capability test: on the
  // reference box OptiX enumerates fine and then dies at kernel load with
  // OPTIX_ERROR_INTERNAL_COMPILER_ERROR. Only a real render proves a backend.
  test('buildDeviceProbeScript: proves each backend by actually rendering', () => {
    const s = buildDeviceProbeScript();
    assert.match(s, /bpy\.ops\.render\.render/);
    assert.match(s, /\['OPTIX', 'CUDA'\]/);
  });

  test('buildDeviceProbeScript: creates a camera (an empty scene fails for unrelated reasons)', () => {
    // Without this the probe dies on "Cannot render, no camera" and falsely
    // condemns every GPU backend to CPU.
    const s = buildDeviceProbeScript();
    assert.match(s, /cameras\.new/);
    assert.match(s, /scene\.camera = /);
  });

  test('buildDeviceProbeScript: keeps the probe render trivially cheap', () => {
    const s = buildDeviceProbeScript();
    assert.match(s, /samples = 1/);
    assert.match(s, /resolution_x = 32/);
  });

  // ── G-FFMPEG-PAT: Blender '#' padding vs ffmpeg '%0Nd' ─────────────────
  // The same base path is handed to Blender (-o) and ffmpeg (-i). Passing
  // Blender's spelling to ffmpeg failed the render at the LAST step, after
  // every frame had already been paid for.
  test('ffmpegPatternFromBlender: #### becomes %04d', () => {
    assert.equal(
      ffmpegPatternFromBlender('/scratch/frame_####.png'),
      '/scratch/frame_%04d.png',
    );
  });

  test('ffmpegPatternFromBlender: pad width follows the run length of #', () => {
    assert.equal(ffmpegPatternFromBlender('f_##.png'), 'f_%02d.png');
    assert.equal(ffmpegPatternFromBlender('f_######.png'), 'f_%06d.png');
  });

  test('ffmpegPatternFromBlender: a pattern with no # is unchanged', () => {
    assert.equal(ffmpegPatternFromBlender('/scratch/still.png'), '/scratch/still.png');
  });

  test('ffmpegPatternFromBlender: Windows paths survive intact', () => {
    assert.equal(
      ffmpegPatternFromBlender(String.raw`C:\tmp\ikenga\frame_####.png`),
      String.raw`C:\tmp\ikenga\frame_%04d.png`,
    );
  });

  // ── Progress parsing against REAL Blender 5.x output ───────────────────
  test('parseFrameFromChunk: Blender 5.x puts a SPACE after Fra:', () => {
    // Verbatim from Blender 5.2.1 stdout — the 4.x-era /Fra:(\d+)/ never
    // matched this, so progress sat at frame 0 for the whole render.
    assert.equal(
      parseFrameFromChunk('00:07.157  render           | Fra: 1 | Rendering 1 / 64 samples'),
      1,
    );
  });

  test('parseFrameFromChunk: still parses the old space-less 4.x spelling', () => {
    assert.equal(parseFrameFromChunk('Fra:12 Mem:40.00M | Time:00:01.20'), 12);
  });

  test('parseFrameFromChunk: takes the LAST frame in a multi-line chunk', () => {
    // stdout arrives in chunks carrying many progress lines; reporting the
    // first makes progress lag and can read as non-monotonic.
    const chunk = [
      'render | Fra: 7 | Rendering 64 / 64 samples',
      'render | Fra: 8 | Rendering 32 / 64 samples',
      'render | Fra: 9 | Rendering 1 / 64 samples',
    ].join('\n');
    assert.equal(parseFrameFromChunk(chunk), 9);
  });

  // ── G-51b: version-brittle binary discovery ────────────────────────────
  test('compareVersionsDesc: numeric, newest first (5.10 > 5.9, 5.2 > 4.3)', () => {
    assert.deepEqual(['4.3', '5.2', '5.10', '5.9'].sort(compareVersionsDesc), [
      '5.10',
      '5.9',
      '5.2',
      '4.3',
    ]);
  });

  test('discoverVersionedBlender: missing root is [] (never throws)', () => {
    assert.deepEqual(discoverVersionedBlender('/nope/does/not/exist', (d) => d), []);
  });

  // ── Anchor-plate failure detection ─────────────────────────────────────
  // Blender exits 0 on an uncaught Python exception (verified 5.2.1), so the
  // script's last-line sentinel is the only trustworthy success signal. A
  // stale output file previously let a FAILED plate render report success.
  test('PLATE_OK_SENTINEL: is a distinct marker, not a device marker prefix', () => {
    assert.ok(PLATE_OK_SENTINEL.length > 0);
    assert.equal(parseDeviceFromChunk(PLATE_OK_SENTINEL), null);
    assert.equal(parseProbeDevice(PLATE_OK_SENTINEL), null);
  });

  test('parseProbeDevice: reads the verdict; unknown backends are rejected', () => {
    assert.equal(parseProbeDevice('[studio] cycles_device_probe=CUDA\n'), 'CUDA');
    assert.equal(parseProbeDevice('[studio] cycles_device_probe=CPU\n'), 'CPU');
    assert.equal(parseProbeDevice('[studio] cycles_device_probe=METAL\n'), null);
    assert.equal(parseProbeDevice('nothing here'), null);
  });

  console.log(`\n${passed} passed`);
  return 0;
}

process.exit(await main());
