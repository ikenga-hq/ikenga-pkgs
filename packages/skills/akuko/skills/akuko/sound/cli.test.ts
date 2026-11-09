// WP-12 — the sound command line over a real project folder (manual provider: free, no network).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createLocalHost, serializeProject } from '../hosts/local.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { run } from './cli.ts';
import { approve, keyframesApproved } from './__fixtures__/project.ts';
import { silentWav } from './__fixtures__/audio.ts';

const T = () => new Date('2026-11-09T10:00:00Z');

async function folder(mutate: (p: ReturnType<typeof keyframesApproved>) => void = () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'akuko-snd-'));
  const p = keyframesApproved();
  mutate(p);
  await writeFile(join(dir, 'akuko.json'), serializeProject(p));
  return { dir, host: createLocalHost({ projectDir: dir, now: T }) };
}

describe('sound cli', () => {
  it('refuses a project whose key frames are not approved', async () => {
    const { dir } = await folder((p) => { p.stages.keyframes = { state: 'in-review' }; });
    const r = await run(['plan', '--project', dir], T);
    assert.equal(r.code, 1);
    assert.match(r.out, /locked: keyframes/);
  });

  it('plan proposes script lines and waits for the person; --script-lines plans them', async () => {
    const { dir, host } = await folder();
    const a = await run(['plan', '--project', dir], T);
    assert.equal(a.code, 0, a.out);
    assert.match(a.out, /no narration, only a script line/);
    assert.match(a.out, /sc1_sh1:/);
    assert.ok(!(await host.readState()).assets.some((x) => x.id === 'sc1_sh1_vo'), 'nothing chosen for the person');
    const b = await run(['plan', '--project', dir, '--script-lines', 'sc1_sh1'], T);
    assert.match(b.out, /sc1_sh1_vo/);
    assert.match((await run(['status', '--project', dir], T)).out, /sc1_sh1_vo: pending \(ready\)/);
  });

  it('plan, step (manual), ingest with a words file, add-music, fold, sync: captions and narration on disk', async () => {
    const { dir, host } = await folder();
    await run(['plan', '--project', dir, '--script-lines', 'sc1_sh1'], T);
    const step = await run(['step', '--project', dir, '--provider', 'manual', '--voice', 'warm'], T);
    assert.equal(step.code, 0, step.out);
    assert.match(step.out, /Read these words exactly/);
    const jobId = /Job (job_snd_\S+?)\./.exec(step.out)![1]!;
    assert.ok(existsSync(join(dir, 'sound', 'jobs', `${jobId}.json`)));
    const unit = (await host.readState()).assets.find((x) => x.status === 'draft')!.id;

    const wav = join(dir, 'take.wav');
    const words = join(dir, 'words.json');
    await writeFile(wav, silentWav(2500));
    await writeFile(words, JSON.stringify([{ word: 'Hello', start_ms: 100, end_ms: 500 }, { word: 'there.', start_ms: 600, end_ms: 1200 }]));
    const noWords = await run(['ingest', '--project', dir, '--job', jobId, '--unit', unit, '--file', wav], T);
    assert.match(noWords.out, /without word timings/);
    assert.equal(noWords.code, 0, noWords.out);
    const att = await run(['words', '--project', dir, '--unit', unit, '--file', words], T);
    assert.equal(att.code, 0, att.out);
    assert.doesNotMatch((await run(['status', '--project', dir], T)).out, /no word timings/);

    const mp3 = join(dir, 'bed.mp3');
    await writeFile(mp3, new Uint8Array([0xff, 0xfb, 1, 2]));
    assert.equal((await run(['add-music', '--project', dir, '--file', mp3], T)).code, 2, 'licence is required');
    const music = await run(['add-music', '--project', dir, '--file', mp3, '--licence', 'own recording', '--source', 'me'], T);
    assert.equal(music.code, 0, music.out);

    let p = await host.readState();
    assert.deepEqual(checkIntegrity(p), []);
    await host.writeState(approve(p, [unit], 'sound').project);
    const sync = await run(['sync', '--project', dir], T);
    assert.equal(sync.code, 0, sync.out);
    assert.match(sync.out, /audio.narration rebuilt: 2 words/);
    p = await host.readState();
    assert.equal(p.audio.narration!.words[0]!.start_ms, 100, 'sc1_sh1 starts the film');
    const vtt = /(\S+captions\S*\.vtt)/.exec(sync.out)![1]!;
    assert.match(await readFile(join(dir, vtt), 'utf8'), /00:00:00\.100 --> 00:00:01\.200\nHello there\./);
    assert.ok(existsSync(join(dir, p.audio.narration!.audio.uri)));
    assert.match((await run(['sync', '--project', dir], T)).out, /up to date/);
  });

  it('a paid provider with no budget is refused with the setup pointer', async () => {
    const { dir } = await folder();
    await run(['plan', '--project', dir, '--script-lines', 'all'], T);
    const r = await run(['step', '--project', dir, '--provider', 'elevenlabs', '--voice', 'v1'], T);
    assert.equal(r.code, 1);
    assert.match(r.out, /Run `\/akuko setup`/);
    const noVoice = await run(['step', '--project', dir, '--provider', 'elevenlabs'], T);
    assert.match(noVoice.out, /Choose a voice/);
  });

  it('needs --project and a known command', async () => {
    assert.equal((await run(['plan'], T)).code, 2);
    const { dir } = await folder();
    assert.equal((await run(['frobnicate', '--project', dir], T)).code, 2);
  });
});
