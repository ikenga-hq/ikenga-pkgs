// `assemble rough`: a free rough cut from approved material, with sound; never a review unit.
// ffmpeg is faked except in the last block, which renders for real when ffmpeg is on PATH (skipped otherwise).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AkukoProjectSchema, type AkukoProject, type Asset } from '../schema/akuko-project.ts';
import { serializeProject } from '../hosts/local.ts';
import { ffmpegOnPath } from '../handoff/render-moves.ts';
import { parseFps } from '../handoff/timecode.ts';
import { PUSH } from '../motion/moves.ts';
import { run } from './cli.ts';
import {
  ROUGH_NOTICE, audioGraph, clipArgs, describeRough, filterFileArgs, filterFileOrder, parseIntegratedLufs, planRough, renderRough, runWithFilterFile, type RoughRunner,
} from './rough.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const fixture = (): AkukoProject => AkukoProjectSchema.parse(JSON.parse(readFileSync(here('../fixtures/the-beating/akuko.json'), 'utf8')));
const FPS = parseFps('24');

const asset = (id: string, kind: Asset['kind'], owner: string, status: Asset['status'], uri: string, stage: Asset['stage'] = 'keyframes', tags: string[] = []): Asset =>
  ({ id, stage, status, comments: [], kind, owner, tags, file: { uri, mime: uri.endsWith('.mp4') ? 'video/mp4' : uri.endsWith('.wav') ? 'audio/wav' : 'image/png' } }) as Asset;

/**
 * The fixture film (12 shots, 70 s) with: approved clips on sc1_sh1 (8 s, longer than its 6 s shot) and sc1_sh2
 * (3 s, shorter than its 4 s shot); approved key frames on every other shot except sc2_sh3 (still in review) and
 * sc2_sh4 (none); approved takes on sc1_sh1 and sc2_sh1, a take still in review on sc1_sh3.
 */
function material(): AkukoProject {
  const p = fixture();
  for (const s of p.shots) {
    if (s.id === 'sc2_sh4') continue;
    p.assets.push(asset(`${s.id}_keyframe`, 'keyframe', s.id, s.id === 'sc2_sh3' ? 'pending-review' : 'approved', `keyframes/${s.id}.png`));
  }
  p.assets.push(asset('sc1_sh1_clip', 'clip', 'sc1_sh1', 'approved', 'motion/sc1_sh1.mp4', 'motion'));
  p.assets.push(asset('sc1_sh2_clip', 'clip', 'sc1_sh2', 'approved', 'motion/sc1_sh2.mp4', 'motion'));
  for (const [shot, status] of [['sc1_sh1', 'approved'], ['sc2_sh1', 'approved'], ['sc1_sh3', 'pending-review']] as const) {
    p.assets.push(asset(`${shot}_vo`, 'vo', shot, status, `audio/vo/${shot}.wav`, 'sound', ['vo']));
  }
  return AkukoProjectSchema.parse(p);
}
const LENGTHS: Record<string, number> = { 'motion/sc1_sh1.mp4': 8, 'motion/sc1_sh2.mp4': 3, 'audio/vo/sc1_sh1.wav': 2.5, 'audio/vo/sc2_sh1.wav': 3 };
const lengthOf = (uri: string): number | undefined => LENGTHS[uri];

const roots: string[] = [];
const scratch = async (): Promise<string> => { const d = await mkdtemp(join(tmpdir(), 'akuko-rough-')); roots.push(d); return d; };
after(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }); });

describe('assemble rough: the picture plan', () => {
  it('uses the approved clip, else the key frame with its move, else black, in film order, each exactly its shot (70 s)', () => {
    const plan = planRough(material(), { fps: FPS, lengthOf });
    assert.equal(plan.mode, 'shots');
    assert.equal(plan.segments.length, 12);
    assert.equal(plan.seconds, 70);
    assert.equal(plan.totalFrames, 70 * 24);
    assert.deepEqual([plan.width, plan.height], [1280, 720], 'the preview frame size');
    assert.deepEqual(plan.segments.map((s) => s.shot), fixture().shots.map((s) => s.id));
    let at = 0;
    for (const s of plan.segments) { assert.equal(s.at, at, `${s.shot} starts where the one before ends`); at += s.frames; }
    const by = new Map(plan.segments.map((s) => [s.shot, s]));
    assert.equal(by.get('sc1_sh1')!.source, 'clip');
    assert.equal(by.get('sc1_sh3')!.source, 'keyframe');
    assert.deepEqual(by.get('sc1_sh3')!.move, PUSH, 'the key frame keeps the shot\'s push-in');
    assert.equal(by.get('sc1_sh1')!.move, undefined);
    assert.equal(by.get('sc2_sh3')!.black, 'no approved clip or key frame yet', 'a key frame still in review is not used');
    assert.equal(by.get('sc2_sh4')!.black, 'no approved clip or key frame yet');
  });

  it('trims a longer clip (plays its start, cuts the end) and holds the last frame of a shorter one', () => {
    const by = new Map(planRough(material(), { fps: FPS, lengthOf }).segments.map((s) => [s.shot, s]));
    assert.deepEqual(by.get('sc1_sh1')!.clip, { asset: 'sc1_sh1_clip', uri: 'motion/sc1_sh1.mp4', seconds: 8, trimFrames: 48, holdFrames: 0 });
    assert.deepEqual(by.get('sc1_sh2')!.clip, { asset: 'sc1_sh2_clip', uri: 'motion/sc1_sh2.mp4', seconds: 3, trimFrames: 0, holdFrames: 24 });
    const exact = new Map(planRough(material(), { fps: FPS, lengthOf: (u) => (u === 'motion/sc1_sh1.mp4' ? 6 : undefined) }).segments.map((s) => [s.shot, s]));
    assert.deepEqual([exact.get('sc1_sh1')!.clip!.trimFrames, exact.get('sc1_sh1')!.clip!.holdFrames], [0, 0], 'a clip of the shot\'s length fits');
    const unknown = exact.get('sc1_sh2')!;
    assert.equal(unknown.clip!.seconds, undefined);
    assert.match(unknown.notes.join(' '), /length could not be read/);
    const text = describeRough(planRough(material(), { fps: FPS, lengthOf }));
    assert.match(text, /sc1_sh1 {2}6 s {2}clip sc1_sh1_clip \(8 s\): plays its first 6 s, cuts the last 2 s \(48 frames\)/);
    assert.match(text, /sc1_sh2 {2}4 s {2}clip sc1_sh2_clip \(3 s\): holds its last frame for 1 s \(24 frames\)/);
    assert.match(text, /sc1_sh3 {2}6 s {2}key frame sc1_sh3_keyframe, gentle move from its camera move \(push-in\)/);
    assert.match(text, /sc2_sh4 {2}6 s {2}black \(no approved clip or key frame yet\)/);
  });

  it('a missing clip file falls back to the key frame and says so; a missing key frame file is a named black', () => {
    const plan = planRough(material(), { fps: FPS, lengthOf, exists: (u) => u !== 'motion/sc1_sh1.mp4' && u !== 'keyframes/sc1_sh3.png' });
    const by = new Map(plan.segments.map((s) => [s.shot, s]));
    assert.equal(by.get('sc1_sh1')!.source, 'keyframe');
    assert.match(by.get('sc1_sh1')!.notes[0]!, /approved clip's file \(motion\/sc1_sh1\.mp4\) was not found/);
    assert.match(by.get('sc1_sh3')!.black!, /key frame file \(keyframes\/sc1_sh3\.png\) was not found/);
  });

  it('leaves out a shot with no duration, with its voice-over and effects, and says so; the rest close up', () => {
    const p = material();
    delete p.shots.find((s) => s.id === 'sc1_sh1')!.duration_s;
    const plan = planRough(p, { fps: FPS, lengthOf, sfx: [{ file: 'hit.wav', shot: 'sc1_sh1' }] });
    assert.equal(plan.segments.length, 11);
    assert.equal(plan.seconds, 64);
    assert.equal(plan.segments[0]!.shot, 'sc1_sh2');
    assert.equal(plan.segments[0]!.at, 0);
    assert.deepEqual(plan.leftOut.map((l) => l.what), ['shot sc1_sh1', 'voice-over sc1_sh1_vo', 'voice-over sc1_sh3_vo', 'effect hit.wav']);
    assert.match(plan.leftOut[0]!.why, /no duration/);
    assert.match(plan.leftOut[2]!.why, /pending-review/);
    assert.deepEqual(plan.problems, [], 'an effect on a real but untimed shot is left out, not a problem');
    assert.equal(plan.audio.find((a) => a.role === 'vo')!.atS, 10.1, 'sc2_sh1 now starts at 10 s');
  });
});

describe('assemble rough: the sound plan', () => {
  it('places each approved take at its shot start + 0.1 s at -16 LUFS; a take in review is left out', () => {
    const plan = planRough(material(), { fps: FPS, lengthOf });
    const vo = plan.audio.filter((a) => a.role === 'vo');
    assert.deepEqual(vo.map((a) => [a.asset, a.shot, a.atS, a.lufs]), [['sc1_sh1_vo', 'sc1_sh1', 0.1, -16], ['sc2_sh1_vo', 'sc2_sh1', 16.1, -16]]);
    assert.match(plan.leftOut.find((l) => l.what === 'voice-over sc1_sh3_vo')!.why, /pending-review/);
    assert.deepEqual(plan.warnings, []);
    const long = planRough(material(), { fps: FPS, lengthOf: (u) => (u === 'audio/vo/sc1_sh1.wav' ? 6.5 : lengthOf(u)) });
    assert.match(long.warnings.join(' '), /sc1_sh1_vo: the take \(6\.5 s\) .* runs 0\.6 s past the end of sc1_sh1; it is kept whole/);
  });

  it('with no approved take, lays the narration track from the start', () => {
    const p = material();
    p.assets = p.assets.filter((a) => a.kind !== 'vo');
    p.audio.narration = { audio: { uri: 'audio/vo/narration.wav', mime: 'audio/wav' }, words: [], duration_ms: 70000, generated_at: '2026-11-20T00:00:00Z' } as never;
    const plan = planRough(AkukoProjectSchema.parse(p), { fps: FPS });
    assert.deepEqual(plan.audio.map((a) => [a.role, a.atS, a.lufs]), [['narration', 0, -16]]);
  });

  it('effects sit at their shot start, trimmed to the shot at -24 LUFS; an unknown shot stops the render', async () => {
    const plan = planRough(material(), { fps: FPS, lengthOf, sfx: [{ file: 'door.wav', shot: 'sc2_sh1' }, { file: 'x.wav', shot: 'sc9_sh9' }] });
    const fx = plan.audio.filter((a) => a.role === 'sfx');
    assert.deepEqual(fx.map((a) => [a.src, a.shot, a.atS, a.maxS, a.lufs]), [['door.wav', 'sc2_sh1', 16, 7, -24]]);
    assert.match(plan.problems[0]!, /no shot sc9_sh9/);
    assert.match(describeRough(plan), /cannot render: --sfx x\.wav@sc9_sh9/);
    await assert.rejects(renderRough(plan, { out: 'never.mp4', pathOf: () => undefined, available: true, versionText: 'ffmpeg version 9.0' }), /cannot be rendered/);
    assert.equal(existsSync('never.mp4'), false);
  });

  it('music starts at its offset and is ducked under the voice; with no voice it is not ducked; room tone is low and looped', () => {
    const plan = planRough(material(), { fps: FPS, lengthOf, music: { file: 'm.wav', offsetS: 6.4 }, roomTone: { file: 'rt.wav' } });
    const m = plan.audio.find((a) => a.role === 'music')!;
    assert.deepEqual([m.skipS, m.ducked, m.lufs, m.maxS], [6.4, true, -24, 70]);
    const rt = plan.audio.find((a) => a.role === 'room-tone')!;
    assert.deepEqual([rt.loop, rt.lufs, rt.maxS], [true, -36, 70]);
    const p = material();
    p.assets = p.assets.filter((a) => a.kind !== 'vo');
    const quiet = planRough(p, { fps: FPS, music: { file: 'm.wav' } });
    assert.equal(quiet.audio[0]!.ducked, false);
    assert.equal(quiet.audio[0]!.skipS, undefined);
  });

  it('names approved music or effects in the project, which are not laid without a flag', () => {
    const p = material();
    p.assets.push(asset('music_theme', 'music', 'sc1_sh1', 'approved', 'audio/music/theme.wav', 'sound', ['supplied', 'placement:film']));
    assert.match(planRough(AkukoProjectSchema.parse(p), { fps: FPS }).warnings.join(' '), /not laid automatically \(music_theme\)/);
  });
});

describe('assemble rough: a project with audio.master', () => {
  function withMaster(): AkukoProject {
    const p = material();
    p.audio.master = { uri: '../master.wav', duration_s: 10, sample_rate: 48000, start_tc: '00:00:00:00' };
    p.shots = p.shots.slice(0, 3);
    p.shots[0]!.film = { in_s: 1, out_s: 4 };
    p.shots[1]!.film = { in_s: 4, out_s: 7 };
    // the third has no film time
    return AkukoProjectSchema.parse(p);
  }

  it('cuts on the master clock: shots at film time, black gaps, the master whole and untouched, takes covered', () => {
    const plan = planRough(withMaster(), { fps: FPS, lengthOf });
    assert.equal(plan.mode, 'master');
    assert.equal(plan.seconds, 10);
    assert.deepEqual(plan.segments.map((s) => [s.shot, s.at, s.frames, s.source]), [['', 0, 24, 'black'], ['sc1_sh1', 24, 72, 'clip'], ['sc1_sh2', 96, 72, 'clip'], ['', 168, 72, 'black']]);
    assert.equal(plan.segments[1]!.clip!.trimFrames, 120, 'the 8 s clip is cut to its 3 s slot');
    assert.equal(plan.segments[2]!.clip!.holdFrames, 0, 'the 3 s clip fills its 3 s slot');
    assert.deepEqual(plan.audio.map((a) => [a.role, a.atS, a.lufs]), [['master', 0, undefined]]);
    assert.match(plan.warnings.join(' '), /covered by the master/);
    assert.match(plan.leftOut.map((l) => l.why).join(' '), /no film time/);
    assert.equal(audioGraph(plan)!.trim(), '[1]atrim=0:10,asetpts=N/SR/TB,aformat=channel_layouts=stereo,aresample=48000[a0];\n[a0]apad,atrim=0:10[mix]', 'the master alone: no loudnorm, no limiter');
    const missing = planRough(withMaster(), { fps: FPS, masterExists: false });
    assert.match(missing.problems[0]!, /master audio is missing/);
  });
});

describe('assemble rough: the mix filtergraph', () => {
  it('follows the recipe: loudnorm and delay per take, ducked music, low room tone, trimmed effects, amix and alimiter', () => {
    const plan = planRough(material(), { fps: FPS, lengthOf, music: { file: 'm.wav', offsetS: 6.4 }, roomTone: { file: 'rt.wav' }, sfx: [{ file: 'a.wav', shot: 'sc2_sh1' }, { file: 'b.wav', shot: 'sc1_sh2' }] });
    const g = audioGraph(plan, 1)!;
    const lines = g.trim().split(';\n');
    assert.equal(lines[0], '[1]aformat=channel_layouts=stereo,aresample=48000,loudnorm=I=-16:TP=-2:LRA=7,adelay=delays=100:all=1[a0]');
    assert.equal(lines[1], '[2]aformat=channel_layouts=stereo,aresample=48000,loudnorm=I=-16:TP=-2:LRA=7,adelay=delays=16100:all=1[a1]');
    assert.equal(lines[2], '[3]atrim=start=6.4,asetpts=N/SR/TB,aformat=channel_layouts=stereo,aresample=48000,loudnorm=I=-24:TP=-4,atrim=0:70,afade=t=out:st=68:d=2[a2]');
    assert.equal(lines[3], '[4]atrim=0:70,asetpts=N/SR/TB,aformat=channel_layouts=stereo,aresample=48000,loudnorm=I=-36:TP=-6,afade=t=out:st=68.5:d=1.5[a3]');
    assert.equal(lines[4], '[5]atrim=0:7,asetpts=N/SR/TB,aformat=channel_layouts=stereo,aresample=48000,loudnorm=I=-24:TP=-6,afade=t=out:st=6.85:d=0.15,adelay=delays=16000:all=1[a4]');
    assert.equal(lines[5], '[6]atrim=0:4,asetpts=N/SR/TB,aformat=channel_layouts=stereo,aresample=48000,loudnorm=I=-24:TP=-6,afade=t=out:st=3.85:d=0.15,adelay=delays=6000:all=1[a5]');
    assert.ok(lines.includes('[a0][a1]amix=inputs=2:normalize=0[vobus]'));
    assert.ok(lines.includes('[a4][a5]amix=inputs=2:normalize=0[sfxbus]'));
    assert.ok(lines.includes('[vobus]asplit=2[vo1][vosc]'));
    assert.ok(lines.includes('[a2][vosc]sidechaincompress=threshold=0.05:ratio=4:attack=20:release=400[musd]'), 'music ducked, keyed from the voice bus');
    assert.equal(lines.at(-1), '[vo1][musd][a3][sfxbus]amix=inputs=4:normalize=0:duration=longest,apad,atrim=0:70,alimiter=limit=0.89[mix]');
  });

  it('a single take needs no bus; a silent cut has no graph', () => {
    const p = material();
    p.assets = p.assets.filter((a) => a.id !== 'sc2_sh1_vo');
    const g = audioGraph(planRough(p, { fps: FPS }))!;
    assert.match(g, /\[a0\]apad,atrim=0:70,alimiter=limit=0\.89\[mix\]/);
    p.assets = p.assets.filter((a) => a.kind !== 'vo');
    const silent = planRough(p, { fps: FPS });
    assert.equal(audioGraph(silent), undefined);
    assert.match(describeRough(silent), /none: the cut is silent/);
  });
});

describe('assemble rough: passing the filtergraph file to old and new ffmpeg', () => {
  it('chooses the way to try first from ffmpeg -version', () => {
    assert.deepEqual(filterFileOrder('ffmpeg version 9.0.1-full_build-www.gyan.dev Copyright'), ['slash', 'script']);
    assert.deepEqual(filterFileOrder('ffmpeg version 7.0 Copyright'), ['slash', 'script']);
    assert.deepEqual(filterFileOrder('ffmpeg version n6.1.1 Copyright'), ['script', 'slash']);
    assert.deepEqual(filterFileOrder('ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright'), ['script', 'slash']);
    assert.deepEqual(filterFileOrder('ffmpeg version N-112345-g0123abcd Copyright'), ['slash', 'script'], 'a git build tries the new way first');
    assert.deepEqual(filterFileOrder(undefined), ['slash', 'script']);
    assert.deepEqual(filterFileArgs('slash', 'mix.txt'), ['-/filter_complex', 'mix.txt']);
    assert.deepEqual(filterFileArgs('script', 'mix.txt'), ['-filter_complex_script', 'mix.txt']);
  });

  it('falls back to the other way when ffmpeg refuses the first, and reports both when both fail', async () => {
    const tried: string[] = [];
    const r = await runWithFilterFile(['slash', 'script'], async (s) => { tried.push(s); if (s === 'slash') throw new Error('Unrecognized option \'/filter_complex\''); return 'ok'; });
    assert.deepEqual([r.style, r.result, tried], ['script', 'ok', ['slash', 'script']]);
    const once = await runWithFilterFile(['script', 'slash'], async () => 'ok');
    assert.equal(once.style, 'script');
    await assert.rejects(runWithFilterFile(['slash', 'script'], async (s) => { throw new Error(`no ${s}`); }), /both ways\. With slash: no slash\nWith script: no script/);
  });

  it('reads the integrated loudness from the ebur128 summary', () => {
    const err = '[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -16.3 LUFS\n    Threshold: -26.5 LUFS\n';
    assert.equal(parseIntegratedLufs(err), -16.3);
    assert.equal(parseIntegratedLufs('nothing here'), undefined);
  });
});

describe('assemble rough: rendering and the command line', () => {
  it('conforms a clip: frame rate, frame size, last frame held (plus a spare), exactly the slot\'s frames, no sound', () => {
    const plan = planRough(material(), { fps: FPS, lengthOf });
    const short = plan.segments.find((s) => s.shot === 'sc1_sh2')!;
    const a = clipArgs(plan, short, 'c.mp4', 'o.mp4');
    const vf = a[a.indexOf('-vf') + 1]!;
    assert.match(vf, /^fps=24\/1,scale=1280:720:force_original_aspect_ratio=decrease/);
    assert.match(vf, /tpad=stop_mode=clone:stop=26/);
    assert.equal(a[a.indexOf('-frames:v') + 1], '96');
    assert.ok(a.includes('-an'));
    const long = clipArgs(plan, plan.segments[0]!, 'c.mp4', 'o.mp4');
    assert.equal(long[long.indexOf('-frames:v') + 1], '144', 'a longer clip is cut at the shot\'s end');
  });

  it('without ffmpeg says so and writes nothing', async () => {
    const r = await renderRough(planRough(material(), { fps: FPS }), { out: 'never.mp4', pathOf: () => undefined, available: false });
    assert.equal(r.status, 'no-ffmpeg');
    assert.match((r as { message: string }).message, /nothing was written/);
    assert.equal(existsSync('never.mp4'), false);
  });

  async function projectOnDisk(): Promise<{ dir: string; json: string }> {
    const dir = await scratch();
    const p = material();
    for (const a of p.assets) {
      if (!a.file || a.kind === 'portrait' || a.kind === 'turnaround' || a.kind === 'plate') continue;
      const f = join(dir, ...a.file.uri.split('/'));
      await mkdir(join(f, '..'), { recursive: true });
      await writeFile(f, 'x');
    }
    const json = serializeProject(p);
    await writeFile(join(dir, 'akuko.json'), json);
    await writeFile(join(dir, 'music.wav'), 'x');
    await writeFile(join(dir, 'door.wav'), 'x');
    return { dir, json };
  }

  function fakeRun(fail?: (args: string[]) => boolean): { run: RoughRunner; calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      run: async (_cmd, args) => {
        calls.push(args);
        if (fail?.(args)) throw new Error('Unrecognized option');
        const last = args[args.length - 1]!;
        if (last.endsWith('.mp4')) await writeFile(last, `fake ${calls.length}`);
        return args.includes('ebur128=framelog=quiet') ? '  Integrated loudness:\n    I:         -16.3 LUFS\n' : '';
      },
    };
  }

  it('renders one part per shot, joins them, mixes the sound, measures it; akuko.json is byte-identical (never a review unit)', async () => {
    const { dir, json } = await projectOnDisk();
    const fake = fakeRun();
    const r = await run(['rough', '--project', dir, '--music', join(dir, 'music.wav'), '--music-offset', '2', '--sfx', `${join(dir, 'door.wav')}@sc2_sh1`], { rough: { available: true, run: fake.run, versionText: 'ffmpeg version 9.0.1' } });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Wrote .*rough-cut\.mp4 \(70 s\)\. Measured loudness: -16\.3 LUFS integrated\./);
    assert.ok(r.out.includes(ROUGH_NOTICE));
    assert.match(ROUGH_NOTICE, /not a review unit/);
    assert.equal(fake.calls.length, 12 + 1 + 1 + 1, '12 parts, the join, the mix, the loudness check');
    assert.ok(fake.calls[12]!.includes('concat'));
    const mix = fake.calls[13]!;
    assert.equal(mix[mix.indexOf('-/filter_complex') + 1]!.endsWith('mix.txt'), true, 'new ffmpeg: -/filter_complex <file>');
    assert.ok(mix.includes('[mix]'));
    assert.ok(existsSync(join(dir, 'cut', 'rough', 'rough-cut.mp4')));
    assert.equal(readFileSync(join(dir, 'akuko.json'), 'utf8'), json, 'akuko.json is untouched');

    const dry = await run(['rough', '--project', dir, '--dry-run'], { rough: { available: true, run: fake.run } });
    assert.equal(dry.code, 0, dry.out);
    assert.equal(fake.calls.length, 15, 'a dry run renders nothing');
    assert.match(dry.out, /^Rough cut: 12 shot\(s\), 70 s at 24 fps, 1280 x 720\./);
    assert.match(dry.out, /voice-over sc1_sh1_vo at 0\.1 s \(start of sc1_sh1 \+ 0\.1 s\), -16 LUFS/);
  });

  it('retries the mix with -filter_complex_script when ffmpeg refuses -/filter_complex', async () => {
    const { dir } = await projectOnDisk();
    const fake = fakeRun((a) => a.includes('-/filter_complex'));
    const r = await run(['rough', '--project', dir, '--out', join(dir, 'x.mp4')], { rough: { available: true, run: fake.run, versionText: 'ffmpeg version 9.0' } });
    assert.equal(r.code, 0, r.out);
    assert.ok(fake.calls.some((a) => a.includes('-filter_complex_script')));
    assert.ok(existsSync(join(dir, 'x.mp4')));
  });

  it('refuses bad bed flags before anything renders', async () => {
    const { dir } = await projectOnDisk();
    const bad = async (...extra: string[]) => (await run(['rough', '--project', dir, '--dry-run', ...extra])).out;
    assert.match(await bad('--sfx', 'door.wav'), /<file>@<shot id>/);
    assert.match(await bad('--sfx', `${join(dir, 'nope.wav')}@sc1_sh1`), /file not found/);
    assert.match(await bad('--music-offset', '3'), /needs --music/);
    assert.match(await bad('--music', join(dir, 'music.wav'), '--music-offset', '-1'), /0 or more/);
    assert.match(await bad('--room-tone', join(dir, 'nope.wav')), /file not found/);
    const unknown = await run(['rough', '--project', dir, '--dry-run', '--sfx', `${join(dir, 'door.wav')}@sc9_sh1`]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.out, /cannot render/);
  });
});

describe('assemble rough: a real render (when ffmpeg is on PATH)', { skip: !ffmpegOnPath() }, () => {
  it('writes an MP4 of the film length with picture and sound', async () => {
    const dir = await scratch();
    const p = fixture();
    p.shots = p.shots.slice(0, 3).map((s) => ({ ...s, duration_s: 1 }));
    const ff = (args: string[]) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    await mkdir(join(dir, 'motion'), { recursive: true });
    await mkdir(join(dir, 'keyframes'), { recursive: true });
    await mkdir(join(dir, 'audio'), { recursive: true });
    ff(['-f', 'lavfi', '-i', 'testsrc=s=320x240:r=30:d=2', '-pix_fmt', 'yuv420p', join(dir, 'motion', 'a.mp4')]); // longer: cut
    ff(['-f', 'lavfi', '-i', 'testsrc=s=320x240:r=30:d=0.5', '-pix_fmt', 'yuv420p', join(dir, 'motion', 'b.mp4')]); // shorter: held
    ff(['-f', 'lavfi', '-i', 'color=c=red:s=64x36', '-frames:v', '1', join(dir, 'keyframes', 'c.png')]);
    ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.6', '-c:a', 'pcm_s16le', join(dir, 'audio', 'vo.wav')]);
    p.assets.push(asset(`${p.shots[0]!.id}_clip`, 'clip', p.shots[0]!.id, 'approved', 'motion/a.mp4', 'motion'));
    p.assets.push(asset(`${p.shots[1]!.id}_clip`, 'clip', p.shots[1]!.id, 'approved', 'motion/b.mp4', 'motion'));
    p.assets.push(asset(`${p.shots[2]!.id}_keyframe`, 'keyframe', p.shots[2]!.id, 'approved', 'keyframes/c.png'));
    p.assets.push(asset(`${p.shots[1]!.id}_vo`, 'vo', p.shots[1]!.id, 'approved', 'audio/vo.wav', 'sound', ['vo']));
    await writeFile(join(dir, 'akuko.json'), serializeProject(AkukoProjectSchema.parse(p)));
    const out = join(dir, 'rough.mp4');
    const r = await run(['rough', '--project', dir, '--out', out]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /holds its last frame/);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', out], { encoding: 'utf8' });
    if (probe.status === 0) {
      const info = JSON.parse(probe.stdout) as { streams: Array<{ codec_type: string; width?: number }>; format: { duration: string } };
      assert.deepEqual(info.streams.map((s) => s.codec_type).sort(), ['audio', 'video']);
      assert.ok(Math.abs(Number(info.format.duration) - 3) < 0.1, `about 3 s, got ${info.format.duration}`);
    } else assert.ok(readFileSync(out).length > 0);
  });
});
