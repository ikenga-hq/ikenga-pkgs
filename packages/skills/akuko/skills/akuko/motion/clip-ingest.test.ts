// Manual clip ingest: a sent-back clip is replaced in place (never a stray `<unit>-motion` asset that holds the stage
// open), the clip's length is checked against its shot, and a clip's own sound is kept as a by-product WAV.
//
// The motion fixture: every stage through key frames approved by a person; sc1_sh1 runs 6 s. "Approved" only ever
// comes from folding a person's decision.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { checkIntegrity } from '../schema/integrity.ts';
import { listUnits, type AkukoProject } from '../schema/akuko-project.ts';
import type { Job } from '../providers/contract.ts';
import { createManualProvider, ManualIngestError } from '../providers/manual/index.ts';
import { createFakeHost, type FakeHost } from '../providers/__fixtures__/fake-host.ts';
import { createLocalHost, serializeProject } from '../hosts/local.ts';
import { createSpendGate } from '../spend/gate.ts';
import { miniMp4 } from '../handoff/__fixtures__/project.ts';
import { ffmpegOnPath, spawnRunner } from '../handoff/render-moves.ts';
import { clipAssets, planMotion } from './plan.ts';
import { finalizeMotion, generateClips, ingestClip } from './run.ts';
import { CLIP_AUDIO_DIR, CLIP_LENGTH_PREFIX, clipLengthText } from './clip-ingest.ts';
import { run } from './cli.ts';
import { approve, decision, fold, keyframesApproved } from './__fixtures__/project.ts';

const NOW = '2026-11-25T10:00:00Z';
const now = (): string => NOW;
const T = (): Date => new Date(NOW);
const CLIP1 = 'sc1_sh1_clip';
const asset = (p: AkukoProject, id: string) => p.assets.find((a) => a.id === id)!;
const mp4 = (seconds: number, audio = false) => ({ filename: 'from-person.mp4', mime: 'video/mp4', data: miniMp4(seconds, audio) });

function rig() {
  const host: FakeHost = createFakeHost(planMotion(keyframesApproved(), NOW).project);
  const manual = createManualProvider(host, { now });
  const gate = createSpendGate({ host, providers: [manual.provider], level: 'B', now });
  return { host, manual, deps: { host, gate, now } };
}

/** One manual step for the next clip; returns its job. */
async function step(r: ReturnType<typeof rig>, units?: string[]): Promise<Job> {
  const s = await generateClips(r.deps, { provider: 'manual', ...(units ? { units } : {}) });
  assert.equal(s.status, 'handoff', JSON.stringify(s));
  return s.job;
}

async function folder() {
  const dir = await mkdtemp(join(tmpdir(), 'akuko-clip-'));
  await writeFile(join(dir, 'akuko.json'), serializeProject(keyframesApproved()));
  return { dir, host: createLocalHost({ projectDir: dir, now: T }) };
}

// ─────────────────────────────────────────────────────────────────────────
describe('ingest into a clip that already has a file (lesson: the stray <unit>-motion asset)', () => {
  it('a sent-back clip ingested into its old job is replaced in place: no stray asset, the old file kept, and the stage can close', async () => {
    const r = rig();
    // Make and approve every clip, remembering which job made each.
    const jobOf = new Map<string, Job>();
    for (let guard = 0; r.host.peek().stages.motion.state !== 'approved' && guard < 40; guard++) {
      const job = await step(r);
      for (const it of job.items) { await ingestClip(r.deps, r.manual, job, it.unit, mp4(6)); jobOf.set(it.unit, job); }
      const waiting = clipAssets(r.host.peek()).filter((a) => a.status === 'pending-review').map((a) => a.id);
      r.host.set(approve(r.host.peek(), waiting, 'motion').project);
      await finalizeMotion(r.deps);
    }
    assert.equal(r.host.peek().stages.motion.state, 'approved');

    // The person sends the first clip back, makes a new one by hand and brings it back against the job that made the old one.
    const oldUri = asset(r.host.peek(), CLIP1).file!.uri;
    r.host.set(fold(r.host.peek(), [decision('request-changes', CLIP1, 'motion', { text: 'Slower.' })]).project);
    assert.equal(asset(r.host.peek(), CLIP1).status, 'needs-rework');
    const assetsBefore = r.host.peek().assets.length;
    const newBytes = miniMp4(6.5);
    const ing = await ingestClip(r.deps, r.manual, jobOf.get(CLIP1)!, CLIP1, { filename: 'take2.mp4', mime: 'video/mp4', data: newBytes });

    let p = r.host.peek();
    assert.equal(ing.asset, CLIP1, 'the new file fills the clip itself');
    assert.equal(p.assets.length, assetsBefore, 'no new asset');
    assert.ok(!p.assets.some((a) => a.id.startsWith(`${CLIP1}-`)), 'no stray <unit>-motion asset');
    const clip = asset(p, CLIP1);
    assert.equal(clip.status, 'pending-review', 'back to the person, never approved by code');
    assert.notEqual(clip.file!.uri, oldUri, 'the clip now shows the new file');
    assert.deepEqual(r.host.files.get(clip.file!.uri), newBytes, 'stored as it is');
    assert.ok(r.host.files.has(oldUri), 'the old file stays stored');
    assert.ok(clip.comments.some((c) => c.author === 'agent' && c.text.startsWith('Revised:') && c.text.includes(oldUri)));
    assert.equal(clip.by_stage?.motion?.output?.uri, clip.file!.uri);
    assert.deepEqual(checkIntegrity(p), []);

    // Approving the one clip closes the stage again: nothing else waits.
    assert.notEqual(p.stages.motion.state, 'approved');
    r.host.set(approve(p, [CLIP1], 'motion').project);
    await finalizeMotion(r.deps);
    p = r.host.peek();
    assert.equal(p.stages.motion.state, 'approved');
    assert.deepEqual(listUnits(p).filter((u) => u.unit.stage === 'motion' && u.unit.status !== 'approved').map((u) => u.unit.id), []);
  });

  it('a clip that has a file and was not sent back is refused, naming the clip and what to do; nothing is stored', async () => {
    const r = rig();
    const job = await step(r, [CLIP1]);
    await ingestClip(r.deps, r.manual, job, CLIP1, mp4(6));
    for (const status of ['pending-review', 'approved'] as const) {
      if (status === 'approved') r.host.set(approve(r.host.peek(), [CLIP1], 'motion').project);
      const before = r.host.peek();
      const files = r.host.files.size;
      await assert.rejects(ingestClip(r.deps, r.manual, job, CLIP1, mp4(6)), (e: unknown) =>
        e instanceof ManualIngestError
        && new RegExp(`"${CLIP1}" already has a file .*${status}\\)\\. Nothing was stored\\.`).test(e.message)
        && /Request changes/.test(e.message) && /ingest the file again/.test(e.message) && new RegExp(`step --units ${CLIP1}`).test(e.message));
      assert.deepEqual(r.host.peek(), before, `${status}: akuko.json unchanged`);
      assert.equal(r.host.files.size, files, `${status}: no file stored`);
    }
  });

  it('on disk through the command line: send back, ingest again into the same job, one clip, both files kept', async () => {
    const { dir, host } = await folder();
    await run(['plan', '--project', dir], T);
    const s = await run(['step', '--project', dir, '--provider', 'manual'], T);
    const jobId = /Job (job_mo_\S+?)\./.exec(s.out)![1]!;
    const file1 = join(dir, 'take1.mp4');
    await writeFile(file1, miniMp4(6));
    assert.equal((await run(['ingest', '--project', dir, '--job', jobId, '--unit', CLIP1, '--file', file1], T)).code, 0);
    const old = asset(await host.readState(), CLIP1).file!.uri;
    await host.writeState(fold(await host.readState(), [decision('request-changes', CLIP1, 'motion', { text: 'Again.' })]).project);

    const file2 = join(dir, 'take2.mp4');
    await writeFile(file2, miniMp4(6.2));
    const ing = await run(['ingest', '--project', dir, '--job', jobId, '--unit', CLIP1, '--file', file2], T);
    assert.equal(ing.code, 0, ing.out);
    assert.match(ing.out, new RegExp(`Recorded ${CLIP1};`));
    const p = await host.readState();
    assert.ok(!p.assets.some((a) => a.id.startsWith(`${CLIP1}-`)));
    const now = asset(p, CLIP1).file!.uri;
    assert.notEqual(now, old);
    assert.ok(existsSync(join(dir, ...old.split('/'))), 'the old take is still on disk');
    assert.deepEqual(readFileSync(join(dir, ...now.split('/'))), await readFile(file2), 'the new take is stored byte for byte');
    assert.deepEqual(checkIntegrity(p), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('clip length against the shot (never refused)', () => {
  it('the comment text: shorter needs a held last frame, much longer is cut at the shot\'s end, close is silent', () => {
    assert.equal(clipLengthText(3, 3.5), 'Clip runs 3 s; the shot is 3.5 s: the last frame needs holding for 0.5 s at assembly (the Resolve export leaves that 0.5 s empty; akuko never stretches or freezes a clip).');
    assert.equal(clipLengthText(8, 6), 'Clip runs 8 s; the shot is 6 s: the export uses its first 6 s and cuts the last 2 s.');
    assert.equal(clipLengthText(6, 6), undefined);
    assert.equal(clipLengthText(6.4, 6), undefined, 'a little longer is normal');
    assert.equal(clipLengthText(5.99, 6), undefined, 'within half a frame');
  });

  it('a 3 s clip on a 6 s shot is recorded, with a warning and one agent comment on the clip; a better take replaces the comment', async () => {
    const r = rig();
    const job = await step(r, [CLIP1]);
    const ing = await ingestClip(r.deps, r.manual, job, CLIP1, mp4(3));
    assert.equal(asset(r.host.peek(), CLIP1).status, 'pending-review', 'recorded for review all the same');
    assert.ok(ing.warnings.some((w) => w.startsWith(`${CLIP1}: Clip runs 3 s; the shot is 6 s: the last frame needs holding for 3 s at assembly`)), ing.warnings.join('|'));
    const mine = (p: AkukoProject) => asset(p, CLIP1).comments.filter((c) => c.author === 'agent' && c.text.startsWith(CLIP_LENGTH_PREFIX)).map((c) => c.text);
    assert.equal(mine(r.host.peek()).length, 1);
    assert.deepEqual(checkIntegrity(r.host.peek()), []);

    // Sent back; the new take is 8 s: the comment is replaced, not piled up.
    r.host.set(fold(r.host.peek(), [decision('request-changes', CLIP1, 'motion', { text: 'Too short.' })]).project);
    const longer = await ingestClip(r.deps, r.manual, job, CLIP1, mp4(8));
    assert.deepEqual(mine(r.host.peek()), ['Clip runs 8 s; the shot is 6 s: the export uses its first 6 s and cuts the last 2 s.']);
    assert.ok(longer.warnings.some((w) => w.includes('cuts the last 2 s')));

    // Sent back again; a 6 s take: no length comment left.
    r.host.set(fold(r.host.peek(), [decision('request-changes', CLIP1, 'motion', { text: 'Again.' })]).project);
    const fits = await ingestClip(r.deps, r.manual, job, CLIP1, mp4(6));
    assert.deepEqual(mine(r.host.peek()), []);
    assert.deepEqual(fits.warnings, []);
  });

  it('a clip whose length cannot be read (webm) says nothing about length', async () => {
    const r = rig();
    const job = await step(r, [CLIP1]);
    const ing = await ingestClip(r.deps, r.manual, job, CLIP1, { filename: 'x.webm', mime: 'video/webm', data: new Uint8Array([26, 69, 223, 163, 1, 2]) });
    assert.deepEqual(ing.warnings, []);
    assert.ok(!asset(r.host.peek(), CLIP1).comments.some((c) => c.text.startsWith(CLIP_LENGTH_PREFIX)));
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("a clip's own sound is kept (a by-product, never an asset)", () => {
  it('with ffmpeg: the sound goes to sound-incoming/clip-audio/<shot>_clip-audio.wav, never over an earlier one; nothing in akuko.json beyond the clip', async () => {
    const r = rig();
    const dir = await mkdtemp(join(tmpdir(), 'akuko-clipaudio-'));
    const calls: string[][] = [];
    const fakeRun = async (_cmd: string, args: string[]) => { calls.push(args); await writeFile(args.at(-1)!, 'RIFF'); };
    const job = await step(r, [CLIP1]);
    const bytes = miniMp4(6, true);
    const without = createFakeHost(r.host.peek());
    const ing = await ingestClip(r.deps, r.manual, job, CLIP1, { filename: 'a.mp4', mime: 'video/mp4', data: bytes }, { keepAudio: { projectDir: dir, source: '/in/a.mp4', available: true, run: fakeRun } });
    assert.equal(ing.audio, `${CLIP_AUDIO_DIR}/sc1_sh1_clip-audio.wav`);
    assert.ok(existsSync(join(dir, 'sound-incoming', 'clip-audio', 'sc1_sh1_clip-audio.wav')));
    assert.deepEqual(calls[0]!.slice(0, 11), ['-hide_banner', '-loglevel', 'error', '-n', '-i', '/in/a.mp4', '-vn', '-map', '0:a:0', '-c:a', 'pcm_s16le']);
    assert.ok(ing.notes.some((n) => n.includes('Kept the clip\'s sound as sound-incoming/clip-audio/sc1_sh1_clip-audio.wav')));
    const clip = asset(r.host.peek(), CLIP1);
    assert.deepEqual(r.host.files.get(clip.file!.uri), bytes, 'the clip is stored as it is, sound and all');

    // The same ingest without keeping sound leaves akuko.json exactly the same: the WAV records nothing.
    const m2 = createManualProvider(without, { now });
    await ingestClip({ host: without, now }, m2, job, CLIP1, { filename: 'a.mp4', mime: 'video/mp4', data: bytes });
    assert.deepEqual(r.host.peek(), without.peek());

    // A later take keeps the earlier WAV and writes -2.
    r.host.set(fold(r.host.peek(), [decision('request-changes', CLIP1, 'motion', { text: 'Again.' })]).project);
    const again = await ingestClip(r.deps, r.manual, job, CLIP1, { filename: 'b.mp4', mime: 'video/mp4', data: bytes }, { keepAudio: { projectDir: dir, source: '/in/b.mp4', available: true, run: fakeRun } });
    assert.equal(again.audio, `${CLIP_AUDIO_DIR}/sc1_sh1_clip-audio-2.wav`);
  });

  it('without ffmpeg: one line, nothing written; a silent clip: nothing at all; an ffmpeg failure is a note, not an error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'akuko-clipaudio-'));
    const r = rig();
    const job = await step(r, [CLIP1]);
    const none = await ingestClip(r.deps, r.manual, job, CLIP1, mp4(6, true), { keepAudio: { projectDir: dir, source: '/in/a.mp4', available: false } });
    assert.deepEqual(none.notes, ['The clip has sound, but ffmpeg was not found, so its sound was not copied to sound-incoming/clip-audio/ (the clip itself is stored with its sound).']);
    assert.equal(none.audio, undefined);
    assert.ok(!existsSync(join(dir, 'sound-incoming')));

    const r2 = rig();
    const job2 = await step(r2, [CLIP1]);
    let ran = 0;
    const silent = await ingestClip(r2.deps, r2.manual, job2, CLIP1, mp4(6), { keepAudio: { projectDir: dir, source: '/in/a.mp4', available: true, run: async () => { ran++; } } });
    assert.equal(ran, 0);
    assert.deepEqual(silent.notes, []);

    const r3 = rig();
    const job3 = await step(r3, [CLIP1]);
    const failed = await ingestClip(r3.deps, r3.manual, job3, CLIP1, mp4(6, true), { keepAudio: { projectDir: dir, source: '/in/a.mp4', available: true, run: async () => { throw new Error('ffmpeg exited 1: no audio stream'); } } });
    assert.match(failed.notes[0] ?? '', /could not be copied out \(ffmpeg exited 1: no audio stream\)/);
    assert.equal(asset(r3.host.peek(), CLIP1).status, 'pending-review', 'the clip is recorded all the same');
  });

  it('a real clip with sound, with the real ffmpeg', { skip: !ffmpegOnPath() && 'ffmpeg is not on PATH' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'akuko-clipaudio-real-'));
    const src = join(dir, 'made.mp4');
    await spawnRunner('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x36:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', src]);
    const r = rig();
    const job = await step(r, [CLIP1]);
    const ing = await ingestClip(r.deps, r.manual, job, CLIP1, { filename: 'made.mp4', mime: 'video/mp4', data: new Uint8Array(await readFile(src)) }, { keepAudio: { projectDir: dir, source: src } });
    assert.equal(ing.audio, `${CLIP_AUDIO_DIR}/sc1_sh1_clip-audio.wav`, ing.notes.join('|'));
    const wav = readFileSync(join(dir, 'sound-incoming', 'clip-audio', 'sc1_sh1_clip-audio.wav'));
    assert.equal(wav.subarray(0, 4).toString('latin1'), 'RIFF');
    assert.ok(ing.warnings.some((w) => w.includes('Clip runs 1 s; the shot is 6 s')));
  });

  it('the command line keeps the sound by default and not with --no-keep-audio; the stored clip is byte for byte the one brought back', async () => {
    for (const flag of [[], ['--no-keep-audio']]) {
      const { dir, host } = await folder();
      await run(['plan', '--project', dir], T);
      const s = await run(['step', '--project', dir, '--provider', 'manual'], T);
      const jobId = /Job (job_mo_\S+?)\./.exec(s.out)![1]!;
      const src = join(dir, 'made.mp4');
      await writeFile(src, miniMp4(3, true));
      const ing = await run(['ingest', '--project', dir, '--job', jobId, '--unit', CLIP1, '--file', src, ...flag], T);
      assert.equal(ing.code, 0, ing.out);
      assert.match(ing.out, /Clip runs 3 s; the shot is 6 s: the last frame needs holding for 3 s at assembly/);
      // The fixture's sound track holds no real audio, so a real ffmpeg fails on it: any of the three lines says it tried.
      const tried = /ffmpeg was not found|Kept the clip's sound|could not be copied out/.test(ing.out);
      assert.equal(tried, flag.length === 0, ing.out);
      const a = asset(await host.readState(), CLIP1);
      assert.deepEqual(readFileSync(join(dir, ...a.file!.uri.split('/'))), await readFile(src));
    }
  });
});
