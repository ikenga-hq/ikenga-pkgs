// Camera moves rendered into clips at export (Resolve 19 drops FCPXML transform keyframes and clip markers).
// Synthetic project (`__fixtures__/master.ts`), invented times. The ffmpeg run is faked except in the last block,
// which renders for real when ffmpeg is on PATH (skipped otherwise).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { moveAt } from './fcpxml.ts';
import { ffmpegOnPath, moveArgs, progressExpr, renderMoves, type Runner } from './render-moves.ts';
import { parseFps } from './timecode.ts';
import { localPath, planFromFolder, writeExport } from './write.ts';
import { buildMasterProject } from './__fixtures__/master.ts';

const roots: string[] = [];
const scratch = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'akuko-moves-'));
  roots.push(d);
  return d;
};
after(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

/** A fake ffmpeg: writes a few bytes (different per call) where the clip would go, and records its arguments. */
function fakeRun(): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (_cmd, args) => {
      calls.push(args);
      await writeFile(args[args.length - 1]!, `fake mp4 ${calls.length}`);
    },
  };
}

/** Evaluate one of our ffmpeg progress expressions in JS (only the functions it uses). */
function evalProgress(expr: string, on: number): number {
  const js = expr.replace(/\bon\b/g, String(on)).replace(/PI/g, 'Math.PI').replace(/\b(cos|sin)\(/g, 'Math.$1(').replace(/clip\(/g, 'clip(');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('clip', `return ${js};`)((x: number, a: number, b: number) => Math.min(b, Math.max(a, x))) as number;
}

describe('the move expression', () => {
  const move = { from_scale: 1, to_scale: 1.15, x: -40, y: -20 };
  for (const ease of [undefined, 'none', 'ease-in', 'ease-out', 'ease-in-out'] as const) {
    it(`follows moveAt for ease ${ease ?? '(none given)'}, reaching the end on the slot's last frame`, () => {
      const mv = { ...move, ...(ease ? { ease } : {}) };
      const of = 54;
      const expr = progressExpr({ move: mv, at: 0, of });
      for (const on of [0, 13, 27, 40, 53]) {
        const want = moveAt(mv, on / (of - 1));
        const k = evalProgress(expr, on);
        assert.ok(Math.abs(mv.from_scale + (mv.to_scale - mv.from_scale) * k - want.scale) < 1e-9, `scale at ${on}`);
        assert.ok(Math.abs(mv.x * k - want.x) < 1e-9, `x at ${on}`);
      }
    });
  }

  it('a piece of the slot carries only its frames of the whole move', () => {
    const mv = { ...move, ease: 'ease-in-out' as const };
    const expr = progressExpr({ move: mv, at: 30, of: 101 });
    assert.ok(Math.abs(evalProgress(expr, 0) - moveAt(mv, 30 / 100).x / mv.x) < 1e-9);
    assert.ok(Math.abs(evalProgress(expr, 70) - 1) < 1e-9);
  });

  it('renders exactly the slot\'s frames at the timeline rate, picture only, with no metadata', () => {
    const a = moveArgs({ image: 'k.png', move: { ...move, ease: 'ease-out' }, frames: 54, at: 0, of: 54, width: 1920, height: 1080, fps: parseFps('23.976') }, 'out.mp4');
    const graph = a[a.indexOf('-filter_complex') + 1]!;
    assert.match(graph, /zoompan=.*d=54:s=1920x1080:fps=24000\/1001/);
    assert.equal(a[a.indexOf('-frames:v') + 1], '54');
    assert.equal(a[a.indexOf('-r') + 1], '24000/1001');
    for (const f of ['-an', '+bitexact']) assert.ok(a.includes(f), f);
    assert.equal(a.at(-1), 'out.mp4');
  });
});

async function masterPlan(): Promise<{ dir: string; plan: Awaited<ReturnType<typeof planFromFolder>>; project: Awaited<ReturnType<typeof buildMasterProject>>['project'] }> {
  const fx = await buildMasterProject(await scratch());
  const plan = await planFromFolder({ project: fx.project, projectDir: fx.dir });
  return { dir: fx.dir, plan, project: fx.project };
}

describe('renderMoves on a master-clock plan', () => {
  it('replaces the moving still with a rendered clip of the same slot, and drops the unused still', async () => {
    const { dir, plan } = await masterPlan();
    const still = plan.video.find((v) => v.shot === 'S01-020')!;
    assert.equal(still.kind, 'still');
    const { run, calls } = fakeRun();
    const r = await renderMoves(plan, { pathOf: (m) => localPath(dir, m.uri), available: true, run, cacheDir: await scratch() });
    assert.equal(r.rendered, 1);
    assert.equal(calls.length, 1);
    const v = r.plan.video.find((e) => e.shot === 'S01-020')!;
    assert.equal(v.kind, 'clip');
    assert.equal(v.rendered, true);
    assert.equal(v.recIn, still.recIn);
    assert.equal(v.frames, still.frames);
    assert.equal(v.media!.role, 'clip');
    assert.match(v.media!.dest, /^media\/002_S01-020_move\.mp4$/);
    assert.equal(v.media!.hasAudio, false);
    assert.ok(!r.plan.media.some((m) => m.role === 'still' && m.shot === 'S01-020'), 'the still is not copied any more');
    assert.ok(r.plan.moves!.every((mv) => mv.rendered));
    // Nothing else moved.
    assert.deepEqual(r.plan.video.filter((e) => e.shot !== 'S01-020'), plan.video.filter((e) => e.shot !== 'S01-020'));
    assert.equal(plan.video.find((e) => e.shot === 'S01-020')!.kind, 'still', 'the input plan is not changed');
  });

  it('reuses the render cache for the same key frame and move', async () => {
    const { dir, plan } = await masterPlan();
    const cacheDir = await scratch();
    const a = fakeRun();
    await renderMoves(plan, { pathOf: (m) => localPath(dir, m.uri), available: true, run: a.run, cacheDir });
    const b = fakeRun();
    const r = await renderMoves(plan, { pathOf: (m) => localPath(dir, m.uri), available: true, run: b.run, cacheDir });
    assert.equal(b.calls.length, 0);
    assert.deepEqual([r.rendered, r.cached], [0, 1]);
  });

  it('a piece held around a lip-sync gets its own clip, named by where it starts in the slot', async () => {
    const { dir, plan } = await masterPlan();
    const i = plan.video.findIndex((v) => v.shot === 'S01-020');
    const v = plan.video[i]!;
    const split = { ...plan, video: [...plan.video.slice(0, i), { ...v, frames: 20, moveSpan: { at: 0, of: 54 } }, { ...v, n: v.n + 100, recIn: v.recIn + 34, frames: 20, moveSpan: { at: 34, of: 54 } }, ...plan.video.slice(i + 1)] };
    const { run, calls } = fakeRun();
    const r = await renderMoves(split, { pathOf: (m) => localPath(dir, m.uri), available: true, run, cacheDir: await scratch() });
    assert.equal(calls.length, 2);
    const dests = r.plan.video.filter((e) => e.shot === 'S01-020').map((e) => e.media!.dest);
    assert.deepEqual(dests, ['media/002_S01-020_move_0.mp4', 'media/002_S01-020_move_34.mp4']);
    assert.match(calls[1]![calls[1]!.indexOf('-filter_complex') + 1]!, /clip\(\(34\+on\)\/53,0,1\)/);
  });

  it('a key frame ffmpeg cannot read keeps its keyframes and a note; the export goes on', async () => {
    const { dir, plan } = await masterPlan();
    const r = await renderMoves(plan, { pathOf: (m) => localPath(dir, m.uri), available: true, run: async () => { throw new Error('ffmpeg exited 1: Invalid data found when processing input'); }, cacheDir: await scratch() });
    assert.equal(r.rendered, 0);
    assert.equal(r.plan.video.find((v) => v.shot === 'S01-020')!.kind, 'still');
    assert.ok(r.plan.media.some((m) => m.role === 'still' && m.shot === 'S01-020'), 'the still is still copied');
    assert.ok(r.plan.warnings.some((w) => /^S01-020: its camera move could not be rendered \(ffmpeg exited 1: Invalid data/.test(w)));
    assert.ok(!r.plan.moves!.some((mv) => mv.rendered));
  });

  it('without ffmpeg, leaves the plan as keyframes and says the moves will arrive static', async () => {
    const { dir, plan } = await masterPlan();
    const r = await renderMoves(plan, { pathOf: (m) => localPath(dir, m.uri), available: false });
    assert.equal(r.plan.video.find((v) => v.shot === 'S01-020')!.kind, 'still');
    assert.ok(r.plan.warnings.some((w) => /ffmpeg was not found/.test(w) && /static/.test(w)));
  });
});

describe('writeExport with rendered moves', () => {
  it('writes the clip, no transform keyframes, and a README that says the move is in the picture', async () => {
    const { dir, project } = await masterPlan();
    const out = join(await scratch(), 'export');
    // Fill the render cache with a fake run first, so the export itself runs no command (the real render is below).
    const cacheDir = await scratch();
    const plan = await planFromFolder({ project, projectDir: dir });
    const { run } = fakeRun();
    await renderMoves(plan, { pathOf: (m) => localPath(dir, m.uri), available: true, run, cacheDir });
    const res = await writeExport({ project, projectDir: dir, outDir: join(out, 'b'), format: 'both', ffmpeg: { available: true, cacheDir } });
    assert.deepEqual(res.moves, { rendered: 0, cached: 1 });
    const fcp = readFileSync(join(out, 'b', 'timeline.fcpxml'), 'utf8');
    assert.ok(!fcp.includes('adjust-transform'), 'no keyframes when the move is in the picture');
    assert.match(fcp, /<asset-clip ref="[^"]+" offset="[^"]+" name="002_S01-020_move"/);
    assert.ok(existsSync(join(out, 'b', 'media', '002_S01-020_move.mp4')));
    assert.ok(!existsSync(join(out, 'b', 'media', '002_S01-020_still.png')));
    const readme = readFileSync(join(out, 'b', 'README.md'), 'utf8');
    assert.match(readme, /rendered into the picture/);
    const edl = readFileSync(join(out, 'b', 'edl', 'video.edl'), 'utf8');
    assert.match(edl, /MOVE S01-020.*\(rendered into the clip\)/);
  });

  it('--moves keyframes keeps the keyframes and marker, and the README says Resolve 19 shows them static', async () => {
    const { dir, project } = await masterPlan();
    const out = join(await scratch(), 'export');
    const res = await writeExport({ project, projectDir: dir, outDir: out, moves: 'keyframes', ffmpeg: { available: true, cacheDir: await scratch() } });
    assert.deepEqual(res.moves, { rendered: 0, cached: 0 });
    const fcp = readFileSync(join(out, 'timeline.fcpxml'), 'utf8');
    assert.match(fcp, /adjust-transform/);
    assert.match(fcp, /<marker /);
    assert.match(readFileSync(join(out, 'README.md'), 'utf8'), /Resolve 19 imports neither/);
  });
});

describe('a real render (when ffmpeg is on PATH)', { skip: !ffmpegOnPath() }, () => {
  it('makes a clip of exactly the slot\'s frames whose picture moves, and a re-export is byte-identical', async () => {
    const { dir, project } = await masterPlan();
    // A key frame with detail, so the move shows: a grid.
    const png = join(dir, 'board', 'keyframes', 'S01-020.png');
    const g = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x2a6f97:size=640x360:d=1', '-vf', 'drawgrid=w=40:h=40:t=2:c=white', '-frames:v', '1', png]);
    assert.equal(g.status, 0, String(g.stderr));
    const out = join(await scratch(), 'export');
    const cacheDir = await scratch();
    const r1 = await writeExport({ project, projectDir: dir, outDir: out, ffmpeg: { cacheDir } });
    assert.deepEqual(r1.moves, { rendered: 1, cached: 0 });
    const clip = join(out, 'media', '002_S01-020_move.mp4');
    const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=nb_read_frames,width,height,r_frame_rate', '-of', 'csv=p=0', clip], { encoding: 'utf8' });
    assert.equal(probe.stdout.trim(), '1920,1080,24/1,54');
    const frame = (n: number): Buffer => spawnSync('ffmpeg', ['-v', 'error', '-i', clip, '-vf', `select=eq(n\\,${n}),scale=96:54`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 20 }).stdout;
    assert.notDeepEqual(frame(0), frame(53), 'the picture moves');
    const before = readFileSync(clip);
    const r2 = await writeExport({ project, projectDir: dir, outDir: out, ffmpeg: { cacheDir } });
    assert.deepEqual(r2.moves, { rendered: 0, cached: 1 });
    assert.ok(r2.unchanged.includes('media/002_S01-020_move.mp4'));
    assert.deepEqual(readFileSync(clip), before);
  });
});
