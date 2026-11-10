// akuko — fal lip-sync provider tests (contract-suite checks live in providers/contract.test.ts). Network is mocked; nothing here calls fal.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { checkIntegrity } from '../../../schema/integrity.ts';
import type { AkukoProject } from '../../../schema/akuko-project.ts';
import { CONFIG_URL, loadProviderConfig, staleModels } from '../../config.ts';
import { costProblems, type Job, type JobItem } from '../../contract.ts';
import { SpendGateBypassError, createSpendGate, isSealed } from '../../../spend/gate.ts';
import { createFakeHost, tinyProject } from '../../__fixtures__/fake-host.ts';
import { REF_URI } from '../../gemini-image/__fixtures__/mock-net.ts';
import { MP4_BYTES, mockFalLipsync } from './__fixtures__/mock-net.ts';
import { mp4Bytes, silentWav, wavDataUri } from './__fixtures__/media.ts';
import {
  DEFAULT_MAX_UPLOAD_BYTES, FAL_LIPSYNC_PROVIDER_ID, billedSeconds, chooseLipsyncModel, createFalLipsyncProvider, falLipsyncLimits, secondsNote, splitModel,
  type FalLipsyncOptions,
} from './index.ts';

const NOW = '2026-11-10T10:00:00Z';
const config = loadProviderConfig();
const entry = config.providers[FAL_LIPSYNC_PROVIDER_ID]!;
const models = Object.keys(entry.models);
const withBudget = (p: AkukoProject): AkukoProject => ({ ...p, budget: { cap: 50, currency: 'USD', spent: 0 } });
const price = (m: string): number => entry.models[m]!.price.amount;

/** Model ids by role, read from config (never written in code). */
const modelFor = (re: RegExp): string => models.find((m) => re.test(m))!;
const H3 = modelFor(/h3-max/);
const FABRIC_480 = modelFor(/fabric.*#480p/);
const FABRIC_720 = modelFor(/fabric.*#720p/);
const KLING = modelFor(/kling/);
const VEED = modelFor(/veed\/lipsync/);

// ── a project folder with real files ────────────────────────────────────
const DIR = mkdtempSync(join(tmpdir(), 'akuko-ls-'));
const OUTSIDE = mkdtempSync(join(tmpdir(), 'akuko-ls-outside-'));
after(() => { rmSync(DIR, { recursive: true, force: true }); rmSync(OUTSIDE, { recursive: true, force: true }); });
let n = 0;
const put = (bytes: Uint8Array, ext: string, dir = DIR): string => {
  const name = `f${++n}${ext}`;
  writeFileSync(join(dir, name), bytes);
  return name;
};
mkdirSync(join(DIR, 'sub'));

const wavFile = (s: number): string => put(silentWav(s), '.wav');
const audioRef = (uri: string, s: number) => ({ id: 'line', uri, role: 'audio', note: secondsNote(s) });
/** Image mode: a still plus a spoken line of `s` seconds (duration_s = the audio's seconds). */
const stillItem = (unit: string, s: number, audio = wavFile(s)): JobItem => ({
  unit, prompt: '', output: 'lipsync', duration_s: s,
  refs: [{ id: 'kf', uri: REF_URI, role: 'start-frame' }, audioRef(audio, s)],
});
/** Video mode: a real mp4 file of `clipS` and a line of `audioS`; `basis` is the billing basis the job declares. */
const clipItem = (unit: string, clipS: number, audioS: number, basis = clipS, clipPath = put(mp4Bytes(clipS), '.mp4')): JobItem => ({
  unit, prompt: '', output: 'lipsync', duration_s: basis,
  refs: [{ id: 'clip', uri: clipPath, role: 'source-video', note: secondsNote(clipS) }, audioRef(wavFile(audioS), audioS)],
});

const job = (items: JobItem[], over: Partial<Job> = {}): Job => ({
  id: 'job_ls_test_r1', stage: 'motion', kind: 'video', provider: FAL_LIPSYNC_PROVIDER_ID, label: 'Lip-sync', items, ...over,
});
const stills = (over: Partial<Job> = {}, secs: [number, number] = [6, 8]): Job => job([stillItem('sc1_sh1', secs[0]), stillItem('sc1_sh2', secs[1])], over);

function setup(net = mockFalLipsync(), o: Partial<FalLipsyncOptions> = {}) {
  const host = createFakeHost(withBudget(tinyProject()));
  const provider = createFalLipsyncProvider(host, { projectDir: DIR, fetch: net.fetch, apiKey: 'test-key', now: () => NOW, ...o });
  const gate = createSpendGate({ host, providers: [provider], level: 'C', now: () => NOW });
  return { host, provider, gate, net };
}

async function approveAndRun(s: ReturnType<typeof setup>, j: Job) {
  assert.equal((await s.gate.run(j)).status, 'awaiting-approval');
  const p = s.host.peek();
  s.host.set({ ...p, pending_spend: p.pending_spend.map((x) => (x.id === j.id ? { ...x, status: 'approved' as const } : x)) });
  return s.gate.run(j);
}
const posts = (s: { net: { calls: Array<{ method: string }> } }) => s.net.calls.filter((c) => c.method === 'POST').length;

/** The JSON body of the first POST of a run, and its url. */
async function firstPost(j: Job, o: Partial<FalLipsyncOptions> = {}) {
  const s = setup(mockFalLipsync(), o);
  const r = await approveAndRun(s, j);
  assert.equal(r.status, 'submitted', JSON.stringify(r));
  const post = s.net.calls.find((c) => c.method === 'POST')!;
  return { post, body: post.body as Record<string, unknown>, s };
}

describe('fal lip-sync provider: contract', () => {
  it('is sealed, paid direct API, hosts B and C only (R-11), video kind; projectDir is required', () => {
    const { provider } = setup();
    assert.ok(isSealed(provider));
    assert.equal(provider.billing, 'direct-api');
    assert.deepEqual([...provider.hosts], ['B', 'C']);
    assert.deepEqual([...provider.kinds], ['video']);
    assert.equal(entry.example, false);
    assert.equal(entry.key_env, 'FAL_KEY');
    assert.throws(() => createFalLipsyncProvider(createFakeHost(tinyProject()), {} as FalLipsyncOptions), /projectDir/);
  });

  it('direct submit() throws SpendGateBypassError and sends nothing', async () => {
    const { provider, host, net } = setup();
    await assert.rejects(provider.submit(stills()), SpendGateBypassError);
    assert.equal(host.writes(), 0);
    assert.equal(net.calls.length, 0);
  });

  it('is refused on host A, and without a budget the gate refuses with the setup pointer', async () => {
    const host = createFakeHost(withBudget(tinyProject()));
    const provider = createFalLipsyncProvider(host, { projectDir: DIR, fetch: mockFalLipsync().fetch, apiKey: 'k' });
    assert.ok((await createSpendGate({ host, providers: [provider], level: 'A' }).run(stills())).status === 'refused');
    const host2 = createFakeHost(tinyProject());
    const p2 = createFalLipsyncProvider(host2, { projectDir: DIR, fetch: mockFalLipsync().fetch, apiKey: 'k' });
    const r = await createSpendGate({ host: host2, providers: [p2], level: 'B' }).run(stills());
    assert.ok(r.status === 'refused' && r.refusal.code === 'no-budget' && /setup/.test(r.refusal.message));
  });

  it('a missing key is refused before anything is sent', async () => {
    const host = createFakeHost(withBudget(tinyProject()));
    const net = mockFalLipsync();
    const provider = createFalLipsyncProvider(host, { projectDir: DIR, fetch: net.fetch, apiKey: () => undefined });
    const gate = createSpendGate({ host, providers: [provider], level: 'C', now: () => NOW });
    const j = stills();
    await gate.run(j);
    const p = host.peek();
    host.set({ ...p, pending_spend: p.pending_spend.map((x) => ({ ...x, status: 'approved' as const })) });
    assert.equal((await gate.run(j)).status, 'failed');
    assert.equal(net.calls.length, 0);
  });
});

describe('fal lip-sync provider: request bodies are pinned per model', () => {
  it('image mode, line of 5-15 s: h3-max, body image_url + audio_url + resolution "768P", nothing else', async () => {
    const { post, body } = await firstPost(stills({}, [6, 8]));
    assert.equal(post.url, `https://queue.fal.run/${H3}`);
    assert.deepEqual(body, { image_url: REF_URI, audio_url: wavDataUri(6), resolution: '768P' });
    assert.equal(post.headers.Authorization, 'Key test-key');
  });

  it('image mode, line under 5 s: fabric 480p, the #resolution suffix becomes the resolution field and never reaches the url', async () => {
    const { post, body } = await firstPost(stills({}, [2.3, 3]));
    assert.equal(post.url, `https://queue.fal.run/${splitModel(FABRIC_480).endpoint}`);
    assert.ok(!post.url.includes('#'));
    assert.deepEqual(body, { image_url: REF_URI, audio_url: wavDataUri(2.3), resolution: '480p' });
  });

  it('a named model is used for every unit; fabric 720p sends "720p"; h3-max refuses a line under 5 s', async () => {
    const { post, body } = await firstPost(stills({ model: FABRIC_720 }, [6, 3]));
    assert.equal(post.url, `https://queue.fal.run/${splitModel(FABRIC_720).endpoint}`);
    assert.deepEqual(body, { image_url: REF_URI, audio_url: wavDataUri(6), resolution: '720p' });
    await assert.rejects(setup().provider.estimate(stills({ model: H3 }, [6, 3])), /takes audio of 5-15 s, not 3\.00 s/);
    await assert.rejects(setup().provider.estimate(stills({ model: H3 }, [6, 16])), /not 16\.00 s/);
  });

  it('a mixed job gets a model per unit: h3-max for the long line, fabric for the short one', async () => {
    const s = setup();
    const c = await s.provider.estimate(stills({}, [8, 2]));
    assert.match(c.basis, new RegExp(`sc1_sh1 ${H3.replace(/[/.]/g, '\\$&')}`));
    assert.match(c.basis, /sc1_sh2 veed\/fabric-1\.0#480p/);
    assert.equal(c.model, undefined);
    assert.ok(Math.abs(c.amount - (price(H3) * 8 + price(FABRIC_480) * 2)) < 1e-9);
  });

  it('video mode, default: Kling gets video_url + audio_url (data: from the mp4 file), nothing else', async () => {
    const j = job([clipItem('sc1_sh1', 6, 3)]);
    const { post, body } = await firstPost(j);
    assert.equal(post.url, `https://queue.fal.run/${KLING}`);
    assert.deepEqual(Object.keys(body).sort(), ['audio_url', 'video_url']);
    assert.match(String(body.video_url), /^data:video\/mp4;base64,/);
    assert.equal(body.audio_url, wavDataUri(3));
  });

  it('video mode, fallback: veed lipsync gets the same two fields; with a line under 2 s the default falls to it', async () => {
    const { post, body } = await firstPost(job([clipItem('sc1_sh1', 5, 8, 8)], { model: VEED }));
    assert.equal(post.url, `https://queue.fal.run/${VEED}`);
    assert.deepEqual(Object.keys(body).sort(), ['audio_url', 'video_url']);
    assert.equal(chooseLipsyncModel(config, 'video', 1, 5), VEED);
    assert.equal(chooseLipsyncModel(config, 'video', 3, 11), VEED);
    assert.equal(chooseLipsyncModel(config, 'video', 3, 6), KLING);
  });

  it('an https still passes through as the url and is not downloaded', async () => {
    const j = stills();
    j.items[0]!.refs = [{ id: 'kf', uri: 'https://files.example.com/a.png', role: 'start-frame' }, audioRef(wavFile(6), 6)];
    const { body, s } = await firstPost(j);
    assert.equal(body.image_url, 'https://files.example.com/a.png');
    assert.ok(!s.net.calls.some((c) => c.url === 'https://files.example.com/a.png'), 'the still is not downloaded');
  });

  it('audio must be a confined project file: an https: or data: audio ref is refused (fal would fetch the URL after it was measured), with no network call', async () => {
    const s = setup();
    for (const uri of ['https://files.example.com/a.wav', wavDataUri(6)]) {
      const j = stills({}, [6, 6]);
      j.items[0]!.refs = [{ id: 'kf', uri: REF_URI, role: 'start-frame' }, audioRef(uri, 6)];
      await assert.rejects(s.provider.estimate(j), /audio: (an https: address is refused for audio.*no bound|a data: URI is refused for audio)/);
    }
    assert.equal(s.net.calls.length, 0, 'nothing is downloaded to measure');
  });

  it('no slack on a maximum: a 15.04 s line (declared 15) routes to fabric, h3-max by name refuses it, and nothing is posted', async () => {
    const j = job([stillItem('sc1_sh1', 15, wavFile(15.04))]);
    const s = setup();
    const c = await s.provider.estimate(j);
    assert.equal(c.model, FABRIC_480);
    assert.ok(Math.abs(c.amount - price(FABRIC_480) * 15.04) < 1e-9, 'priced at the larger measured length, on fabric');
    await assert.rejects(s.provider.estimate({ ...j, model: H3 }), /takes audio of 5-15 s, not 15\.04 s/);
    assert.equal(chooseLipsyncModel(config, 'image', 15.04), FABRIC_480);
    assert.equal(chooseLipsyncModel(config, 'image', 15), H3);
    assert.equal(s.net.calls.length, 0);
    // a clip at 10.04 s is likewise over Kling's 10 s
    await assert.rejects(s.provider.estimate(job([clipItem('sc1_sh1', 10, 3, 10, put(mp4Bytes(10.04), '.mp4'))], { model: KLING })), /takes a clip of 2-10 s, not 10\.04 s/);
  });
});

describe('fal lip-sync provider: video mode bills the clip, not the line', () => {
  it('Kling is priced on the source clip, rounded up to 5 s: a 2.3 s line on a 10 s clip is 10 s; a 12 s line on a 10 s clip is allowed and also 10 s', async () => {
    const { provider } = setup();
    const short = await provider.estimate(job([clipItem('sc1_sh1', 10, 2.3)], { model: KLING }));
    assert.ok(Math.abs(short.amount - price(KLING) * 10) < 1e-9, String(short.amount));
    assert.match(short.basis, /10 s billed \(clip 10\.00 s, audio 2\.30 s\)/);
    const long = await provider.estimate(job([clipItem('sc1_sh1', 10, 12)], { model: KLING }));
    assert.ok(Math.abs(long.amount - price(KLING) * 10) < 1e-9);
  });

  it('a 4 s clip bills 5 s, a 7 s clip 10 s, a 5 s clip 5 s', async () => {
    const { provider } = setup();
    for (const [clip, billed] of [[4, 5], [7, 10], [5, 5], [2, 5]] as const) {
      const c = await provider.estimate(job([clipItem('sc1_sh1', clip, 3)], { model: KLING }));
      assert.ok(Math.abs(c.amount - price(KLING) * billed) < 1e-9, `${clip} s clip`);
    }
  });

  it('Kling refuses a clip outside 2-10 s and audio outside 2-60 s; the clip limit is on the clip, not the line', async () => {
    const { provider } = setup();
    await assert.rejects(provider.estimate(job([clipItem('sc1_sh1', 11, 3)], { model: KLING })), /takes a clip of 2-10 s, not 11\.00 s/);
    await assert.rejects(provider.estimate(job([clipItem('sc1_sh1', 1.5, 3)], { model: KLING })), /takes a clip of 2-10 s/);
    await assert.rejects(provider.estimate(job([clipItem('sc1_sh1', 6, 1)], { model: KLING })), /takes audio of 2-60 s, not 1\.00 s/);
    await assert.rejects(provider.estimate(job([clipItem('sc1_sh1', 6, 61)], { model: KLING })), /takes audio of 2-60 s, not 61\.00 s/);
    await provider.estimate(job([clipItem('sc1_sh1', 6, 59)], { model: KLING }));
  });

  it('veed lipsync bills output seconds: the longer of clip and line', async () => {
    const { provider } = setup();
    const a = await provider.estimate(job([clipItem('sc1_sh1', 5, 8, 8)], { model: VEED }));
    assert.ok(Math.abs(a.amount - price(VEED) * 8) < 1e-9);
    const b = await provider.estimate(job([clipItem('sc1_sh1', 9, 2, 9)], { model: VEED }));
    assert.ok(Math.abs(b.amount - price(VEED) * 9) < 1e-9);
    // duration_s must be that basis
    await assert.rejects(provider.estimate(job([clipItem('sc1_sh1', 5, 8, 5)], { model: VEED })), /duration_s is 5 s but .* the longer of clip and audio, 8 s/);
  });

  it('duration_s must be the billing basis: the clip for Kling, the line in image mode', async () => {
    const { provider } = setup();
    await assert.rejects(provider.estimate(job([clipItem('sc1_sh1', 10, 3, 3)], { model: KLING })), /duration_s is 3 s but .* bills the source clip, 10 s/);
    const bad = stills();
    bad.items[0]!.duration_s = 9;
    await assert.rejects(provider.estimate(bad), /duration_s is 9 s but .* bills the audio, 6 s/);
  });

  it('a clip needs its declared length, a line in video mode too', async () => {
    const { provider } = setup();
    const noClip = job([clipItem('sc1_sh1', 6, 3)], { model: KLING });
    delete noClip.items[0]!.refs![0]!.note;
    await assert.rejects(provider.estimate(noClip), /source-video ref needs a note "seconds=/);
    const noAudio = job([clipItem('sc1_sh1', 6, 3)], { model: KLING });
    delete noAudio.items[0]!.refs![1]!.note;
    await assert.rejects(provider.estimate(noAudio), /audio ref needs a note/);
  });
});

describe('fal lip-sync provider: measure, do not trust', () => {
  it('a line declared 5 s that is really 12 s is refused, and nothing is posted', async () => {
    const s = setup();
    const j = stills({}, [6, 6]);
    j.items[0]!.refs = [{ id: 'kf', uri: REF_URI, role: 'start-frame' }, audioRef(wavFile(12), 5)];
    j.items[0]!.duration_s = 5;
    await assert.rejects(s.provider.estimate(j), /declared 5 s but the file is 12\.00 s/);
    assert.equal(s.net.calls.length, 0);
  });

  it('a clip declared 5 s that is really 9 s is refused', async () => {
    const j = job([clipItem('sc1_sh1', 5, 3, 5, put(mp4Bytes(9), '.mp4'))], { model: KLING });
    await assert.rejects(setup().provider.estimate(j), /clip: declared 5 s but the file is 9\.00 s/);
  });

  it('within 0.05 s is accepted', async () => {
    const j = stills({}, [6, 6]);
    j.items[0]!.refs = [{ id: 'kf', uri: REF_URI, role: 'start-frame' }, audioRef(wavFile(6.04), 6)];
    await setup().provider.estimate(j);
  });

  it('only WAV audio: an mp3 path, an mp3 data: URI and a 24-bit WAV are refused with a clear message', async () => {
    const { provider } = setup();
    const mp3 = put(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), '.mp3');
    const j1 = stills({}, [6, 6]);
    j1.items[0]!.refs = [{ id: 'kf', uri: REF_URI, role: 'start-frame' }, audioRef(mp3, 6)];
    await assert.rejects(provider.estimate(j1), /not an allowed audio type .*convert other audio to WAV/);
    const j2 = stills({}, [6, 6]);
    j2.items[0]!.refs = [{ id: 'kf', uri: REF_URI, role: 'start-frame' }, audioRef('data:audio/mpeg;base64,AAAA', 6)];
    await assert.rejects(provider.estimate(j2), /a data: URI is refused for audio/);
    const j3 = stills({}, [6, 6]);
    const bad = silentWav(6);
    new DataView(bad.buffer, bad.byteOffset).setUint16(34, 24, true);
    j3.items[0]!.refs = [{ id: 'kf', uri: REF_URI, role: 'start-frame' }, audioRef(put(bad, '.wav'), 6)];
    await assert.rejects(provider.estimate(j3), /only 16-bit WAV is supported.*Only WAV audio is accepted/);
  });

  it('a clip that is not an mp4/mov file, or whose length cannot be read, is refused; a clip may not be a data: URI or an https address', async () => {
    const { provider } = setup();
    const junk = job([clipItem('sc1_sh1', 6, 3, 6, put(new Uint8Array(64), '.mp4'))], { model: KLING });
    await assert.rejects(provider.estimate(junk), /could not read the clip's length/);
    const webm = job([clipItem('sc1_sh1', 6, 3, 6, put(mp4Bytes(6), '.webm'))], { model: KLING });
    await assert.rejects(provider.estimate(webm), /not an allowed video type/);
    const data = job([clipItem('sc1_sh1', 6, 3)], { model: KLING });
    data.items[0]!.refs![0]!.uri = 'data:video/mp4;base64,AAAA';
    await assert.rejects(provider.estimate(data), /cannot be given as a data: URI/);
    const web = job([clipItem('sc1_sh1', 6, 3)], { model: KLING });
    web.items[0]!.refs![0]!.uri = 'https://files.example.com/c.mp4';
    await assert.rejects(provider.estimate(web), /cannot be measured here/);
  });
});

describe('fal lip-sync provider: everything is checked before the first request', () => {
  it('unit 2 with a bad file is refused before unit 1 is queued', async () => {
    const good = clipItem('sc1_sh1', 6, 3);
    const later = clipItem('sc1_sh2', 6, 3);
    const j = job([good, later], { model: KLING });
    const s = setup();
    assert.equal((await s.gate.run(j)).status, 'awaiting-approval');
    const p = s.host.peek();
    s.host.set({ ...p, pending_spend: p.pending_spend.map((x) => ({ ...x, status: 'approved' as const })) });
    // After approval, unit 2's file is swapped for one that is too long for the model.
    writeFileSync(join(DIR, later.refs![0]!.uri!), mp4Bytes(14));
    // The gate quotes again before it submits, so the swapped file is caught there; either way nothing is posted.
    await assert.rejects(s.gate.run(j), /sc1_sh2" clip: declared 6 s but the file is 14\.00 s/);
    assert.equal(posts(s), 0, 'unit 1 was not queued');
    await assert.rejects(s.provider.estimate(j), /sc1_sh2" clip: declared 6 s but the file is 14\.00 s/);
  });

  it('a line that changed length after approval is refused at submit and nothing is posted', async () => {
    const name = put(silentWav(6), '.wav');
    const j = stills({}, [6, 6]);
    j.items[0]!.refs = [{ id: 'kf', uri: REF_URI, role: 'start-frame' }, audioRef(name, 6)];
    const s = setup();
    await s.gate.run(j);
    const p = s.host.peek();
    s.host.set({ ...p, pending_spend: p.pending_spend.map((x) => ({ ...x, status: 'approved' as const })) });
    writeFileSync(join(DIR, name), silentWav(12));
    await assert.rejects(s.gate.run(j), /declared 6 s but the file is 12\.00 s/);
    assert.equal(s.net.calls.length, 0);
  });
});

describe('fal lip-sync provider: files stay inside the project', () => {
  const withAudio = (uri: string): Job => {
    const j = stills({}, [6, 6]);
    j.items[0]!.refs = [{ id: 'kf', uri: REF_URI, role: 'start-frame' }, audioRef(uri, 6)];
    return j;
  };

  it('a relative path in the project, in a subfolder and by file:// inside it are read', async () => {
    const name = put(silentWav(6), '.wav');
    writeFileSync(join(DIR, 'sub', 'x.wav'), silentWav(6));
    const { provider } = setup();
    await provider.estimate(withAudio(name));
    await provider.estimate(withAudio('sub/x.wav'));
    await provider.estimate(withAudio(pathToFileURL(join(DIR, name)).href));
    await provider.estimate(withAudio(resolve(DIR, name)));
  });

  it('an absolute path outside, a file:// outside and a ../ escape are refused', async () => {
    const out = put(silentWav(6), '.wav', OUTSIDE);
    const { provider } = setup();
    await assert.rejects(provider.estimate(withAudio(join(OUTSIDE, out))), /outside the project folder and the allowed roots/);
    await assert.rejects(provider.estimate(withAudio(pathToFileURL(join(OUTSIDE, out)).href)), /outside the project folder and the allowed roots/);
    const rel = join('..', OUTSIDE.split(/[\\/]/).pop()!, out).replace(/\\/g, '/');
    await assert.rejects(provider.estimate(withAudio(`sub/../${rel}`)), /outside the project folder and the allowed roots/);
    await assert.rejects(provider.estimate(withAudio('sub/../../nope.wav')), /(outside|not found)/);
  });

  it('a clip outside is refused too, and an allowed extra root is accepted', async () => {
    const outClip = put(mp4Bytes(6), '.mp4', OUTSIDE);
    const j = job([clipItem('sc1_sh1', 6, 3, 6, join(OUTSIDE, outClip))], { model: KLING });
    await assert.rejects(setup().provider.estimate(j), /outside the project folder and the allowed roots/);
    const ok = setup(mockFalLipsync(), { allowRoots: [OUTSIDE] });
    const c = await ok.provider.estimate(j);
    assert.ok(Math.abs(c.amount - price(KLING) * 10) < 1e-9);
  });

  it('plain http: is refused; other schemes are refused; an unknown extension is refused', async () => {
    const { provider } = setup();
    await assert.rejects(provider.estimate(withAudio('http://files.example.com/a.wav')), /plain http: is refused/);
    await assert.rejects(provider.estimate(withAudio('ftp://files.example.com/a.wav')), /not readable/);
    writeFileSync(join(DIR, 'notes.txt'), 'x');
    await assert.rejects(provider.estimate(withAudio('notes.txt')), /not an allowed audio type/);
    await assert.rejects(provider.estimate(withAudio('missing.wav')), /file not found/);
  });
});

describe('fal lip-sync provider: inline upload cap', () => {
  it('a file over the cap is refused from its size before it is read, naming CDN upload as the follow-up', async () => {
    const big = put(silentWav(6), '.wav');
    const s = setup(mockFalLipsync(), { maxUploadBytes: 1000 });
    const j = stills({}, [6, 6]);
    j.items[0]!.refs = [{ id: 'kf', uri: REF_URI, role: 'start-frame' }, audioRef(big, 6)];
    await assert.rejects(s.provider.estimate(j), /over the 0\.0 MB data: URI cap.*CDN upload, which is a follow-up/);
    await assert.rejects(s.provider.estimate(stills({}, [6, 6])), /over the .* data: URI cap/, 'a data: URI is capped too');
    assert.equal(s.net.calls.length, 0);
  });

  it('the default cap is 4 MB and a clip over it is refused', async () => {
    assert.equal(DEFAULT_MAX_UPLOAD_BYTES, 4 * 1024 * 1024);
    const bigClip = Buffer.concat([Buffer.from(mp4Bytes(6)), Buffer.alloc(DEFAULT_MAX_UPLOAD_BYTES)]);
    const j = job([clipItem('sc1_sh1', 6, 3, 6, put(bigClip, '.mp4'))], { model: KLING });
    await assert.rejects(setup().provider.estimate(j), /clip is 4\.\d MB, over the 4\.0 MB data: URI cap/);
  });
});

describe('fal lip-sync provider: shape checks', () => {
  it('refuses a missing audio ref, a missing or doubled picture, the wrong picture kind for a model, a count above one, a non-video job and an unknown model', async () => {
    const { provider } = setup();
    const noAudio = stills({ model: H3 });
    noAudio.items[0]!.refs = noAudio.items[0]!.refs!.filter((r) => r.role !== 'audio');
    await assert.rejects(provider.estimate(noAudio), /exactly one audio segment/);

    const noPic = stills({ model: H3 });
    noPic.items[0]!.refs = noPic.items[0]!.refs!.filter((r) => r.role === 'audio');
    await assert.rejects(provider.estimate(noPic), /exactly one picture/);

    const both = stills({ model: H3 });
    both.items[0]!.refs!.push({ id: 'c', uri: 'x.mp4', role: 'source-video' });
    await assert.rejects(provider.estimate(both), /exactly one picture/);

    await assert.rejects(provider.estimate(stills({ model: KLING })), /gives a still but .* takes a video plus audio/);
    await assert.rejects(provider.estimate(job([clipItem('sc1_sh1', 6, 6)], { model: H3 })), /gives a video but .* takes a still plus audio/);

    const two = stills({ model: H3 });
    two.items[0]!.count = 2;
    await assert.rejects(provider.estimate(two), /one video per unit/);
    await assert.rejects(provider.estimate({ ...stills({ model: H3 }), kind: 'image' }), /makes video/);
    await assert.rejects(provider.estimate({ ...stills(), model: 'nope' }), /not configured/);
  });

  it('billedSeconds applies the floor and rounds up to the step', () => {
    assert.equal(billedSeconds(4, { billingStep: 5 }), 5);
    assert.equal(billedSeconds(5, { billingStep: 5 }), 5);
    assert.equal(billedSeconds(7, { billingStep: 5 }), 10);
    assert.equal(billedSeconds(0.4, { minBilledS: 1 }), 1);
    assert.equal(billedSeconds(7), 7);
  });

  it('estimate() makes no network call and writes nothing', async () => {
    const { provider, net, host } = setup();
    const c = await provider.estimate(stills());
    assert.deepEqual(costProblems(stills(), c), []);
    assert.deepEqual(await provider.estimate(stills()), c);
    assert.equal(net.calls.length, 0);
    assert.equal(host.writes(), 0);
  });

  it('fabric is priced at max(line, 1 s): a 0.4 s line costs one second', async () => {
    const c = await setup().provider.estimate(job([stillItem('sc1_sh1', 0.4)]));
    assert.ok(Math.abs(c.amount - price(FABRIC_480)) < 1e-9);
  });
});

describe('fal lip-sync provider: run through the gate', () => {
  it('runs end to end: lipsync assets land as pending-review, ledger settles, nothing approved', async () => {
    const s = setup();
    const j = stills();
    const r = await approveAndRun(s, j);
    assert.equal(r.status, 'submitted');
    if (r.status !== 'submitted') return;
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(r.handle)));
    assert.equal((await s.provider.poll(r.handle)).state, 'done');
    const c = await s.gate.collect(r.handle);
    assert.equal(c.status.state, 'done');
    const p = s.host.peek();
    assert.deepEqual(checkIntegrity(p), []);
    assert.equal(c.assets.length, 2);
    for (const a of c.assets) {
      assert.equal(a.kind, 'lipsync');
      assert.equal(a.file?.mime, 'video/mp4');
      assert.ok(a.tags.includes(`job:${j.id}`) && a.tags.includes(FAL_LIPSYNC_PROVIDER_ID));
      assert.notEqual(a.status, 'approved');
    }
    assert.deepEqual([...(s.host.files.get(c.assets[0]!.file!.uri) ?? [])], [...MP4_BYTES]);
    assert.ok(p.ledger.length === 2 && p.ledger.every((e) => e.status === 'done' && (e.actual ?? 0) > 0));
  });

  it('one failed unit of two is kept at 0 and the made one is recorded', async () => {
    const s = setup(mockFalLipsync({ error: (k) => (k === 2 ? 'content policy' : undefined) }));
    const r = await approveAndRun(s, stills());
    if (r.status !== 'submitted') throw new Error('not submitted');
    const st = await s.provider.poll(r.handle);
    assert.equal(st.state, 'done');
    assert.deepEqual(st.actual, { sc1_sh2: 0 });
    const c = await s.gate.collect(r.handle);
    assert.deepEqual(c.assets.map((a) => a.id), ['sc1_sh1-motion']);
  });

  it('a result with no video fails the unit; a 5xx reading it stays running; a 4xx is final', async () => {
    const one = (): Job => job([stillItem('sc1_sh1', 6)]);
    const s1 = setup(mockFalLipsync({ noVideo: () => true }));
    const r1 = await approveAndRun(s1, one());
    if (r1.status !== 'submitted') throw new Error('not submitted');
    assert.equal((await s1.provider.poll(r1.handle)).state, 'failed');

    let broken = true;
    const s2 = setup(mockFalLipsync({ resultFail: () => (broken ? '5xx' : undefined) }));
    const r2 = await approveAndRun(s2, one());
    if (r2.status !== 'submitted') throw new Error('not submitted');
    assert.equal((await s2.gate.collect(r2.handle)).status.state, 'running');
    broken = false;
    assert.equal((await s2.gate.collect(r2.handle)).status.state, 'done');

    const s3 = setup(mockFalLipsync({ resultFail: () => '4xx' }));
    const r3 = await approveAndRun(s3, one());
    if (r3.status !== 'submitted') throw new Error('not submitted');
    assert.equal((await s3.gate.collect(r3.handle)).status.state, 'failed');
  });
});

describe('fal lip-sync provider: config', () => {
  it('every configured model has request rules, a fal.ai source and a per-second price', () => {
    assert.ok(models.length >= 4);
    for (const m of models) {
      assert.ok(falLipsyncLimits(m), `${m} has rules`);
      assert.match(entry.models[m]!.source, /https:\/\/fal\.ai\//, m);
      assert.equal(entry.models[m]!.price.per, 'second');
    }
    assert.equal(falLipsyncLimits(splitModel(FABRIC_480).endpoint), undefined, 'a per-resolution endpoint needs its #resolution');
  });

  it('chooses by measured line length: h3-max for 5-15 s, fabric 480p under 5 s (and over 15 s); Kling for a clip of 2-10 s with a 2-60 s line', () => {
    assert.equal(chooseLipsyncModel(config, 'image', 5), H3);
    assert.equal(chooseLipsyncModel(config, 'image', 15), H3);
    assert.equal(chooseLipsyncModel(config, 'image', 4.9), FABRIC_480);
    assert.equal(chooseLipsyncModel(config, 'image', 2.3), FABRIC_480);
    assert.equal(chooseLipsyncModel(config, 'image', 16), FABRIC_480);
    assert.equal(chooseLipsyncModel(config, 'video', 2.3, 10), KLING);
  });

  it("the fabric entry says fal's page does not give the billing basis and that akuko prices max(audio, 1 s)", () => {
    assert.match(entry.models[FABRIC_480]!.source, /does not say whether .*audio or output seconds/);
    assert.match(entry.models[FABRIC_480]!.source, /max\(audio, 1 s\)/);
  });

  it('is not stale, and the block sits right before the example entries', () => {
    assert.deepEqual(staleModels(config, '2026-11-10').filter((s) => s.provider === FAL_LIPSYNC_PROVIDER_ID), []);
    const order = Object.keys(JSON.parse(readFileSync(CONFIG_URL, 'utf8')).providers);
    assert.equal(order.indexOf(FAL_LIPSYNC_PROVIDER_ID), order.indexOf('example-direct-image') - 1);
  });
});
