// `assemble preview` (B-11): a free animatic from the approved key frames, timed to the shots, never a review unit.
// ffmpeg is faked except in the last block, which renders for real when ffmpeg is on PATH (skipped otherwise).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AkukoProjectSchema, type AkukoProject } from '../schema/akuko-project.ts';
import { serializeProject } from '../hosts/local.ts';
import { ffmpegOnPath } from '../handoff/render-moves.ts';
import { parseFps } from '../handoff/timecode.ts';
import { PUSH } from '../motion/moves.ts';
import { run } from './cli.ts';
import { PREVIEW_NOTICE, describePreview, planPreview, previewMove, renderPreview, segmentArgs, type Runner } from './preview.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const fixture = (): AkukoProject => AkukoProjectSchema.parse(JSON.parse(readFileSync(here('../fixtures/the-beating/akuko.json'), 'utf8')));
const FPS = parseFps('24');

/** The Beating with every key frame approved except sc2_sh3 (still waiting) and sc2_sh4 (none yet). */
function withFrames(): AkukoProject {
  const p = fixture();
  for (const s of p.shots) {
    if (s.id === 'sc2_sh4') continue;
    p.assets.push({ id: `${s.id}_keyframe`, stage: 'keyframes', status: s.id === 'sc2_sh3' ? 'pending-review' : 'approved', comments: [], kind: 'keyframe', owner: s.id, tags: [], file: { uri: `keyframes/${s.id}.png`, mime: 'image/png' } });
  }
  return AkukoProjectSchema.parse(p);
}

const roots: string[] = [];
const scratch = async (): Promise<string> => { const d = await mkdtemp(join(tmpdir(), 'akuko-preview-')); roots.push(d); return d; };
after(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }); });

function fakeRun(): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, run: async (_cmd, args) => { calls.push(args); await writeFile(args[args.length - 1]!, `fake ${calls.length}`); } };
}

describe('assemble preview: the plan', () => {
  it('holds each approved key frame for its shot, in film order, black where none is approved (the film is 70 s)', () => {
    const plan = planPreview(withFrames(), { fps: FPS });
    assert.equal(plan.segments.length, 12);
    assert.equal(plan.seconds, 70);
    assert.equal(plan.totalFrames, 70 * 24);
    assert.deepEqual([plan.width, plan.height], [1280, 720]);
    assert.deepEqual(plan.segments.map((s) => s.shot), fixture().shots.map((s) => s.id));
    const by = new Map(plan.segments.map((s) => [s.shot, s]));
    assert.equal(by.get('sc1_sh1')!.frames, 144);
    assert.equal(by.get('sc2_sh3')!.black, 'no approved key frame yet', 'a frame still in review is not used');
    assert.equal(by.get('sc2_sh4')!.black, 'no approved key frame yet');
    assert.deepEqual(by.get('sc1_sh1')!.keyframe, { asset: 'sc1_sh1_keyframe', uri: 'keyframes/sc1_sh1.png' });
  });

  it('moves only where the shot asks: push-ins move, statics hold, a whip-pan gets no move (slow moves only)', () => {
    const by = new Map(planPreview(withFrames(), { fps: FPS }).segments.map((s) => [s.shot, s]));
    assert.deepEqual(by.get('sc1_sh3')!.move, PUSH);
    assert.match(by.get('sc1_sh3')!.moveFrom!, /camera move \(push-in\)/);
    assert.deepEqual(by.get('sc4_sh2')!.move, PUSH);
    for (const id of ['sc1_sh1', 'sc1_sh2', 'sc2_sh1', 'sc4_sh4']) assert.equal(by.get(id)!.move, undefined, id);
    const s = fixture().shots[0]!;
    assert.deepEqual(previewMove({ ...s, move: { from_scale: 1, to_scale: 1.04, x: 0, y: 0 } }).move, { from_scale: 1, to_scale: 1.04, x: 0, y: 0 });
    assert.match(previewMove({ ...s, motion_note: 'Slow pull-back; dust' }).from!, /motion note/);
    assert.match(previewMove({ ...s, camera: 'Slow dolly in' }).from!, /camera note/);
    assert.equal(previewMove({ ...s, camera: 'Static, low angle' }).move, undefined);
  });

  it('leaves out a shot with no length or one removed from the shot list, and says so; a missing file is black', () => {
    const p = withFrames();
    delete p.shots[1]!.duration_s;
    const plan = planPreview(p, { fps: FPS, exists: (uri) => uri !== 'keyframes/sc1_sh3.png' });
    assert.deepEqual(plan.leftOut, [{ shot: 'sc1_sh2', why: 'it has no duration, so it cannot be timed' }]);
    assert.match(plan.segments.find((s) => s.shot === 'sc1_sh3')!.black!, /not found/);
    const text = describePreview(plan);
    assert.match(text, /^Animatic preview: 11 shot\(s\), 66 s at 24 fps, 1280 x 720, silent\./);
    assert.match(text, /left out sc1_sh2/);
    assert.ok(text.endsWith(PREVIEW_NOTICE));
    assert.match(PREVIEW_NOTICE, /not a review unit/);
  });

  it('builds the segment commands: the export move renderer for a move, a held still, black for a gap', () => {
    const plan = planPreview(withFrames(), { fps: FPS });
    const by = new Map(plan.segments.map((s) => [s.shot, s]));
    const move = segmentArgs(plan, by.get('sc1_sh3')!, 'kf.png', 'o.mp4');
    assert.ok(move.some((a) => a.includes('zoompan')), 'a move uses zoompan (handoff/render-moves.ts)');
    const still = segmentArgs(plan, by.get('sc1_sh1')!, 'kf.png', 'o.mp4');
    assert.deepEqual(still.slice(still.indexOf('-loop'), still.indexOf('-loop') + 4), ['-loop', '1', '-i', 'kf.png']);
    assert.equal(still[still.indexOf('-frames:v') + 1], '144');
    const black = segmentArgs(plan, by.get('sc2_sh4')!, undefined, 'o.mp4');
    assert.ok(black.includes('color=c=black:s=1280x720:r=24/1'));
  });
});

describe('assemble preview: rendering and the command line', () => {
  it('without ffmpeg says so and writes nothing', async () => {
    const r = await renderPreview(planPreview(withFrames(), { fps: FPS }), { out: 'never.mp4', pathOf: () => undefined, available: false });
    assert.equal(r.status, 'no-ffmpeg');
    assert.equal(existsSync('never.mp4'), false);
  });

  it('renders one part per shot and joins them; the project file is byte-identical afterwards (never a review unit)', async () => {
    const dir = await scratch();
    const p = withFrames();
    await mkdir(join(dir, 'keyframes'), { recursive: true });
    for (const a of p.assets) if (a.kind === 'keyframe') await writeFile(join(dir, ...a.file!.uri.split('/')), 'png');
    const json = serializeProject(p);
    await writeFile(join(dir, 'akuko.json'), json);
    const fake = fakeRun();
    const r = await run(['preview', '--project', dir], { available: true, run: fake.run });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Wrote .*animatic-preview\.mp4 \(70 s\)/);
    assert.match(r.out, /Preview only: not a review unit/);
    assert.equal(fake.calls.length, 13, '12 parts and one join');
    assert.ok(fake.calls.at(-1)!.includes('concat'));
    assert.ok(existsSync(join(dir, 'cut', 'preview', 'animatic-preview.mp4')));
    assert.equal(readFileSync(join(dir, 'akuko.json'), 'utf8'), json, 'akuko.json is untouched');

    const dry = await run(['preview', '--project', dir, '--dry-run'], { available: true, run: fake.run });
    assert.equal(fake.calls.length, 13, 'a dry run renders nothing');
    assert.match(dry.out, /sc1_sh3 {2}6 s {2}sc1_sh3_keyframe, gentle move from its camera move \(push-in\)/);
  });

  it('host A: reads the project from a saved state file and the key frames from a downloads folder', async () => {
    const dir = await scratch();
    const p = withFrames();
    for (const a of p.assets) if (a.kind === 'keyframe') a.file = { uri: `/_blob/${a.id.replace(/_/g, '')}`, mime: 'image/png' };
    await writeFile(join(dir, 'state.json'), serializeProject(p));
    await mkdir(join(dir, 'media'));
    await writeFile(join(dir, 'media', 'sc1_sh1_keyframe.png'), 'png');
    const r = await run(['preview', '--state', join(dir, 'state.json'), '--media', join(dir, 'media'), '--dry-run']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /sc1_sh1 {2}6 s {2}sc1_sh1_keyframe, held still/);
    assert.match(r.out, /sc1_sh2 {2}4 s {2}black \(its key frame file .* was not found\)/);
    assert.equal((await run(['preview', '--state', join(dir, 'state.json')])).code, 2, '--media is required with --state');
    assert.equal((await run(['rough-cut', '--project', dir])).code, 2, 'the rest of assemble is not built');
  });
});

describe('assemble preview: a real render (when ffmpeg is on PATH)', { skip: !ffmpegOnPath() }, () => {
  it('writes a playable MP4 of the film length', async () => {
    const dir = await scratch();
    const p = fixture();
    p.shots = p.shots.slice(0, 3).map((s) => ({ ...s, duration_s: 1 })); // short: sc1_sh3 is a push-in
    await mkdir(join(dir, 'keyframes'), { recursive: true });
    for (const s of p.shots.slice(0, 2)) {
      spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x36', '-frames:v', '1', join(dir, 'keyframes', `${s.id}.png`)]);
      p.assets.push({ id: `${s.id}_keyframe`, stage: 'keyframes', status: 'approved', comments: [], kind: 'keyframe', owner: s.id, tags: [], file: { uri: `keyframes/${s.id}.png`, mime: 'image/png' } });
    }
    p.shots[1]!.camera_move = 'push-in';
    const plan = planPreview(AkukoProjectSchema.parse(p), { fps: FPS });
    const out = join(dir, 'preview.mp4');
    const r = await renderPreview(plan, { out, pathOf: (uri) => join(dir, ...uri.split('/')) });
    assert.equal(r.status, 'written');
    const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,width,height', '-of', 'csv=p=0', out], { encoding: 'utf8' });
    if (probe.status === 0) assert.equal(probe.stdout.trim(), '1280,720,72', 'three 1 s shots at 24 fps');
    else assert.ok(readFileSync(out).length > 0);
  });
});
