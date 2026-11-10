// WP-28b — the WAV slicer (sound/wav.ts) and the line-audio cutter (lipsync/cut.ts), on synthetic WAVs.
//
// The master is a 24-bit file; a slice must hold exactly the frames of its range, each the source
// sample's top 16 bits, and be recorded per WP-26's slice contract so the rules guard accepts it.
// No network is used anywhere in this file.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { checkIntegrity } from '../schema/integrity.ts';
import { parseSliceTag, sha256Bytes, sliceTag, SLICE_PROVIDER } from '../rules/refs.ts';
import { checkJob } from '../rules/check.ts';
import { framesOf, isPcm16, parseWav, readWavLayout, sliceWavTo16, to16, wavBytes } from '../sound/wav.ts';
import { cutAudio, resolveAll } from './cut.ts';
import { assetIdFor, buildLipsyncJob, cutIdFor, planLipsync, wantedSpan } from './plan.ts';
import { RATE, T0, allowRules, lipsyncFolder, sample24, wav24 } from './__fixtures__/project.ts';

globalThis.fetch = (() => { throw new Error('a real network call was attempted'); }) as typeof fetch;

const tmpFile = async (name: string, data: Uint8Array): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'akuko-wav-'));
  const p = join(dir, name);
  await writeFile(p, data);
  return p;
};
const int16 = (wav: Uint8Array): Int16Array => { const w = parseWav(wav); return new Int16Array(w.pcm.buffer.slice(w.pcm.byteOffset, w.pcm.byteOffset + w.pcm.byteLength)); };

describe('the WAV slicer (sound/wav.ts)', () => {
  it('reads a 24-bit layout through an odd-length extra chunk', async () => {
    const path = await tmpFile('m.wav', wav24(RATE * 3, { extra: true }));
    const l = await readWavLayout(path);
    assert.deepEqual({ tag: l.tag, encoding: l.encoding, bits: l.bits, channels: l.channels, sampleRate: l.sampleRate, frames: l.frames }, { tag: 1, encoding: 'pcm', bits: 24, channels: 1, sampleRate: RATE, frames: RATE * 3 });
    assert.equal(l.dataOffset, 12 + 8 + 16 + 8 + 18 + 8); // RIFF header, fmt, LIST (17 bytes + 1 pad), data header
    assert.equal(isPcm16(l), false);
  });

  it('a slice is sample-exact and 16-bit, read in odd-sized chunks, with the whole file hashed on the way', async () => {
    const bytes = wav24(RATE * 3, { extra: true });
    const path = await tmpFile('m.wav', bytes);
    const ranges = [framesOf(1.25, 2.5, RATE), { startFrame: 0, endFrame: 1 }, framesOf(2.9, 3.5, RATE)]; // the last runs past the end: clamped
    const r = await sliceWavTo16(path, ranges, { chunkBytes: 4093 }); // a prime: frames straddle chunk ends
    // Tiny chunks on a tiny file: every frame is split across reads.
    const tiny = await sliceWavTo16(await tmpFile('t.wav', wav24(300, { extra: true })), [{ startFrame: 17, endFrame: 290 }], { chunkBytes: 7 });
    assert.deepEqual([...int16(tiny.slices[0]!.wav)], Array.from({ length: 273 }, (_, i) => sample24(17 + i) >> 8));
    assert.equal(r.sha256, sha256Bytes(bytes));
    const [a, b, c] = r.slices;
    assert.deepEqual(a!.range, { startFrame: 10000, endFrame: 20000 });
    const w = parseWav(a!.wav);
    assert.equal(w.bits, 16);
    assert.equal(w.sampleRate, RATE);
    assert.equal(w.frames, 10000);
    const s = int16(a!.wav);
    for (let i = 0; i < s.length; i++) assert.equal(s[i], sample24(10000 + i) >> 8, `frame ${10000 + i}`);
    assert.equal(int16(b!.wav)[0], sample24(0) >> 8);
    assert.deepEqual(c!.range, { startFrame: Math.round(2.9 * RATE), endFrame: RATE * 3 });
  });

  it('reads in bounded chunks, never the whole file at once', async () => {
    const bytes = wav24(RATE * 100); // 2.4 MB: more than two default chunks
    const path = await tmpFile('big.wav', bytes);
    for (const chunkBytes of [undefined, 4096]) {
      const reads: number[] = [];
      const r = await sliceWavTo16(path, [framesOf(40, 42.5, RATE)], { ...(chunkBytes ? { chunkBytes } : {}), onRead: (n) => reads.push(n) });
      const cap = chunkBytes ?? 1 << 20;
      assert.ok(Math.max(...reads) <= cap, `no read over ${cap} bytes (largest ${Math.max(...reads)})`);
      assert.ok(Math.max(...reads) < bytes.length / 2, 'no read holds the file');
      assert.ok(reads.length >= Math.ceil(bytes.length / cap), `${reads.length} reads`);
      assert.equal(reads.reduce((a, b) => a + b, 0), bytes.length, 'every byte read once (for the hash)');
      assert.equal(r.sha256, sha256Bytes(bytes));
      assert.equal(parseWav(r.slices[0]!.wav).frames, 2.5 * RATE);
    }
  });

  it('keeps channels (24-bit extensible stereo) and copies a 16-bit source byte for byte', async () => {
    const st = await sliceWavTo16(await tmpFile('s.wav', wav24(100, { channels: 2, extensible: true })), [{ startFrame: 10, endFrame: 20 }]);
    assert.equal(st.layout.tag, 0xfffe);
    const s = int16(st.slices[0]!.wav);
    assert.equal(parseWav(st.slices[0]!.wav).channels, 2);
    for (let i = 0; i < 10; i++) {
      assert.equal(s[i * 2], sample24(10 + i, 0) >> 8);
      assert.equal(s[i * 2 + 1], sample24(10 + i, 1) >> 8);
    }
    const pcm = new Uint8Array(200).map((_, i) => (i * 37) & 0xff);
    const sixteen = await sliceWavTo16(await tmpFile('c.wav', wavBytes(pcm, RATE)), [{ startFrame: 5, endFrame: 50 }]);
    assert.deepEqual(parseWav(sixteen.slices[0]!.wav).pcm, pcm.subarray(10, 100));
  });

  it('converts float and 8-bit, and refuses an empty range', async () => {
    const f = new Uint8Array(12);
    new DataView(f.buffer).setFloat32(0, 0.5, true);
    new DataView(f.buffer).setFloat32(4, -2, true);
    new DataView(f.buffer).setFloat32(8, 1, true);
    assert.deepEqual([...new Int16Array(to16(f, { encoding: 'float', bits: 32 }).buffer)], [Math.round(0.5 * 32767), -32767, 32767]);
    assert.deepEqual([...new Int16Array(to16(new Uint8Array([128, 0, 255]), { encoding: 'pcm', bits: 8 }).buffer)], [0, -32768, 127 << 8]);
    const path = await tmpFile('m.wav', wav24(RATE));
    await assert.rejects(sliceWavTo16(path, [{ startFrame: 9000, endFrame: 9500 }]), /holds no frames/);
  });
});

describe('cutting the line audio (lipsync/cut.ts)', () => {
  it('cuts each master span once, 16-bit and sample-exact, recorded per the slice contract; a usable clip is used as it is', async () => {
    const { dir, files, project } = await lipsyncFolder();
    const planned = planLipsync(project, T0).project;
    const before = structuredClone(planned);
    const r = await cutAudio(planned, { projectDir: dir, now: T0, chunkBytes: 4093 });
    assert.deepEqual(before, planned, 'the input project is not changed');
    assert.deepEqual(r.cut.sort(), [cutIdFor('S02-010'), cutIdFor('S03-010')]);
    assert.equal(r.masterSha256, sha256Bytes(files.master!.data));
    assert.ok(r.notes.some((n) => /S02-020_lipsync: uses line L02's own clip \(clips\/L02\.wav\) as it is/.test(n)), r.notes.join('\n'));
    assert.ok(r.notes.some((n) => n.includes(`sha256 ${r.masterSha256}`) && /record-master-hash/.test(n)), 'tells the person to record the master hash');
    assert.equal(r.project.audio?.master?.sha256, undefined, 'never writes audio.master itself');

    const one = r.project.assets.find((a) => a.id === cutIdFor('S02-010'))!;
    const span = wantedSpan(r.project, r.project.shots[0]!)!;
    assert.deepEqual(span, { in_s: 0.8, out_s: 2.8 }); // L01 1.0-2.5 plus 0.2 s before and 0.3 s after
    assert.equal(one.provider, SLICE_PROVIDER);
    assert.equal(one.kind, 'vo');
    assert.equal(one.stage, 'motion');
    assert.equal(one.status, 'pending-review');
    assert.equal(one.owner, 'S02-010');
    assert.ok(one.tags.includes(sliceTag(r.masterSha256!, 0.8, 2.8)), one.tags.join(' '));
    assert.deepEqual(one.film, span);
    const bytes = new Uint8Array(await readFile(join(dir, ...one.file!.uri.split('/'))));
    assert.equal(one.file!.hash, createHash('sha256').update(bytes).digest('hex'));
    const s = int16(bytes);
    assert.equal(s.length, 2 * RATE);
    for (let i = 0; i < s.length; i++) assert.equal(s[i], sample24(0.8 * RATE + i) >> 8);
    assert.equal(r.project.assets.find((a) => a.id === assetIdFor('S02-010'))!.film, undefined, 'set when a job starts, from the audio it sends');

    const two = r.project.assets.find((a) => a.id === cutIdFor('S03-010'))!;
    assert.deepEqual(parseSliceTag(two.tags.find((t) => t.startsWith('slice-of:'))!), { sha256: r.masterSha256, in_s: 20.3, out_s: 26.3 }); // one span over L05 and L06
    assert.ok(two.tags.includes('lines:L05,L06'));
    assert.deepEqual(checkIntegrity(r.project), []);

    // Running it again cuts nothing: the cuts are current.
    const again = await cutAudio(r.project, { projectDir: dir, now: T0 });
    assert.deepEqual(again.cut, []);
  });

  it('the cut passes WP-26\'s slice check, and only with slices: true for its source', async () => {
    const { dir, files, project: start } = await lipsyncFolder({ rules: true });
    const planned = planLipsync(start, T0).project;
    const { project } = await cutAudio(planned, { projectDir: dir, now: T0 });
    const audio = await resolveAll(project, { projectDir: dir });
    const { job } = buildLipsyncJob(project, { provider: 'fal-lipsync', shot: 'S02-010', audio });
    const ok = await checkJob(project, job, { projectDir: dir });
    assert.equal(ok.outcome, 'ok', JSON.stringify(ok.breaches));

    const noSlices = structuredClone(project);
    noSlices.rules = allowRules(files) as typeof noSlices.rules;
    noSlices.rules!.uploads.allow[0]!.slices = false;
    const bad = await checkJob(noSlices, job, { projectDir: dir });
    assert.equal(bad.outcome, 'rules-breach');
    assert.match(bad.breaches.map((b) => b.message).join('\n'), /is a slice of sha256 .* not in rules\.uploads\.allow with slices: true/);
  });

  it('a recorded master hash that no longer matches the file refuses the cut', async () => {
    const { dir, project: start } = await lipsyncFolder();
    const p = planLipsync(start, T0).project;
    p.audio!.master!.sha256 = 'a'.repeat(64);
    const r = await cutAudio(p, { projectDir: dir, now: T0 });
    assert.deepEqual(r.cut, []);
    assert.ok(r.notes.some((n) => /is not the file whose hash is recorded/.test(n)), r.notes.join('\n'));
    assert.equal(existsSync(join(dir, 'lipsync', 'cuts')), false, 'nothing was written');
  });

  it('a 24-bit line clip is converted to a 16-bit copy, recorded as a slice of the clip', async () => {
    const { dir, project: start } = await lipsyncFolder();
    await writeFile(join(dir, 'clips', 'L02.wav'), wav24(Math.round(2.45 * RATE)));
    const p = planLipsync(start, T0).project;
    const r = await cutAudio(p, { projectDir: dir, now: T0 });
    const c = r.project.assets.find((a) => a.id === cutIdFor('S02-020'))!;
    const clipHash = sha256Bytes(new Uint8Array(await readFile(join(dir, 'clips', 'L02.wav'))));
    assert.deepEqual(parseSliceTag(c.tags.find((t) => t.startsWith('slice-of:'))!), { sha256: clipHash, in_s: 0, out_s: 2.45 });
    assert.equal(c.film, undefined, 'a clip\'s place on the master is not known');
    const w = parseWav(new Uint8Array(await readFile(join(dir, ...c.file!.uri.split('/')))));
    assert.equal(w.bits, 16);
    assert.equal(w.frames, Math.round(2.45 * RATE));
  });
});
