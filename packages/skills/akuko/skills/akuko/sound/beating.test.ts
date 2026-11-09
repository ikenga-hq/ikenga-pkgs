// WP-12 — the sound stage on the REAL short-story fixture: "The Beating" (Poe's The
// Tell-Tale Heart, 12 shots, 70 s, every script line Poe's own words).
//
// plan (script lines confirmed) -> one job per shot through the gate -> mocked TTS ->
// a person approves by folding decisions -> sync -> captions. The TTS network is mocked
// (nothing here makes a live call); the mocked timings are test data.
//
// Two reads: a realistic pace (70 ms per character), where several of Poe's long lines
// do not fit their shots and are skipped with a named warning, and a faster read
// (35 ms per character), where all twelve fit and every shot's words are exactly Poe's.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { listUnits, type AkukoProject } from '../schema/akuko-project.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import type { Provider, WaveOneHost } from '../providers/contract.ts';
import { createManualProvider } from '../providers/manual/index.ts';
import { createElevenLabsProvider } from '../providers/tts/elevenlabs/index.ts';
import { createFakeHost, type FakeHost } from '../providers/__fixtures__/fake-host.ts';
import { createSpendGate } from '../spend/gate.ts';
import { captionsFromNarration, formatSrt, formatVtt } from './captions.ts';
import { rebuildNarration, shotStarts } from './narration.ts';
import { planSound, voAssets } from './plan.ts';
import { generateVoiceover } from './run.ts';
import { mockElevenLabs } from './__fixtures__/audio.ts';
import { beatingKeyframesApproved } from './__fixtures__/beating.ts';
import { approve, approveSpend } from './__fixtures__/project.ts';

const NOW = '2026-11-09T10:00:00Z';
const now = (): string => NOW;
const VOICE = 'voice_test_1';
const SOURCE = readFileSync(fileURLToPath(new URL('../fixtures/short-story/source.md', import.meta.url)), 'utf8');
const norm = (t: string): string => t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s*[—–]\s*/g, '-').replace(/\s+/g, ' ').trim();

const approvedSet = (p: AkukoProject): Set<string> => new Set(listUnits(p).filter((u) => u.unit.status === 'approved').map((u) => u.unit.id));

function guarded(host: FakeHost): WaveOneHost {
  return {
    ...host,
    async writeState(p) {
      const before = approvedSet(host.peek());
      for (const id of approvedSet(p)) assert.ok(before.has(id), `code wrote "approved" for ${id}`);
      await host.writeState(p);
    },
  };
}

async function makeAll(perCharMs: number) {
  const project = planSound(beatingKeyframesApproved({ budget: { cap: 10, currency: 'USD' } }), NOW, { scriptLines: 'all' }).project;
  const host = createFakeHost(project);
  const g = guarded(host);
  const net = mockElevenLabs({ perCharMs });
  const providers: Provider[] = [createManualProvider(g, { now }).provider, createElevenLabsProvider(g, { fetch: net.fetch, apiKey: 'test-key', now })];
  const gate = createSpendGate({ host: g, providers, level: 'B', now });
  const deps = { host: g, gate, now };
  const jobs: string[] = [];
  for (let i = 0; i < project.shots.length; i++) {
    const o = { provider: 'elevenlabs', voice: VOICE };
    let step = await generateVoiceover(deps, o);
    if (step.status === 'awaiting-approval') {
      host.set(approveSpend(host.peek(), step.job.id, 'sound').project);
      step = await generateVoiceover(deps, o);
    }
    assert.equal(step.status, 'done', JSON.stringify(step));
    jobs.push(step.job.id);
  }
  const readFile = async (uri: string): Promise<Uint8Array> => host.files.get(uri) ?? (() => { throw new Error(`no file ${uri}`); })();
  return { host, g, net, jobs, readFile };
}

describe('The Beating (the real short-story fixture): sound end to end', () => {
  it('is the 12-shot Poe fixture, sound is open without motion, and every script line is only proposed until confirmed', () => {
    const p = beatingKeyframesApproved();
    assert.equal(p.shots.length, 12);
    assert.equal(shotStarts(p.shots).totalMs, 70_000);
    assert.equal(p.stages.keyframes.state, 'approved');
    assert.notEqual(p.stages.motion.state, 'approved');
    for (const s of p.shots) assert.ok(SOURCE.replace(/\s+/g, ' ').includes(s.script_line!.trim().replace(/\s+/g, ' ')) || norm(SOURCE).includes(norm(s.script_line!)), `${s.id} is Poe's own words`);
    const r = planSound(p, NOW);
    assert.equal(r.created.length, 0);
    assert.equal(r.proposals.length, 12, 'nothing is chosen for the person');
  });

  it('at a faster read all 12 lines fit: each shot\'s words are exactly Poe\'s line, inside its shot; captions match', async () => {
    const { host, g, net, jobs, readFile } = await makeAll(35);
    assert.equal(net.calls.length, 12);
    assert.equal(new Set(jobs).size, 12, 'one job per shot');
    assert.equal(host.peek().ledger.length, 12);
    host.set(approve(host.peek(), voAssets(host.peek()).map((a) => a.id), 'sound').project);
    assert.equal(host.peek().stages.sound.state, 'approved');

    const res = await rebuildNarration({ host: g, readFile, now });
    assert.ok(res.status === 'built' && res.overrun.length === 0 && !res.trackSkipped, JSON.stringify(res));
    const p = host.peek();
    const n = p.audio.narration!;
    const { starts, durations, totalMs } = shotStarts(p.shots);
    assert.equal(n.duration_ms, totalMs);
    for (let i = 1; i < n.words.length; i++) assert.ok(n.words[i]!.start_ms >= n.words[i - 1]!.start_ms && n.words[i]!.end_ms >= n.words[i - 1]!.end_ms);
    let total = 0;
    for (const shot of p.shots) {
      const start = starts.get(shot.id)!;
      const mine = n.words.filter((w) => w.start_ms >= start && w.end_ms <= start + durations.get(shot.id)!);
      assert.equal(mine.map((w) => w.word).join(' ').replace(/\s+/g, ' '), shot.script_line!.trim().replace(/\s+/g, ' '), `${shot.id}: Poe's words, nothing added or dropped`);
      assert.equal(mine[0]!.start_ms, start);
      total += mine.length;
    }
    assert.equal(total, n.words.length);

    const cues = captionsFromNarration(n);
    assert.equal(res.captions!.cues, cues.length);
    assert.equal(new TextDecoder().decode(host.files.get(res.captions!.vtt)!), formatVtt(cues));
    assert.equal(new TextDecoder().decode(host.files.get(res.captions!.srt)!), formatSrt(cues));
    assert.equal(cues[0]!.start_ms, n.words[0]!.start_ms);
    assert.equal(cues.at(-1)!.end_ms, n.words.at(-1)!.end_ms);
    for (const c of cues) {
      const inside = n.words.filter((w) => w.start_ms >= c.start_ms && w.end_ms <= c.end_ms);
      assert.equal(inside[0]!.start_ms, c.start_ms);
      assert.equal(inside.at(-1)!.end_ms, c.end_ms);
    }
    assert.deepEqual(checkIntegrity(p), []);
    console.log('BEATING 35ms FIRST 3 CUES:', JSON.stringify(cues.slice(0, 3)));
  });

  it('at a realistic pace (70 ms per character) overrunning lines are flagged at review and skipped by sync; the rest still builds', async () => {
    const { host, g, jobs, readFile } = await makeAll(70);
    assert.equal(jobs.length, 12);
    const p0 = host.peek();
    const over = p0.shots.filter((s) => s.script_line!.trim().length * 70 > s.duration_s! * 1000).map((s) => s.id);
    const fit = p0.shots.filter((s) => !over.includes(s.id)).map((s) => s.id);
    assert.ok(over.length >= 5 && fit.length >= 1, `a realistic pace overruns several of Poe's lines (${over.length} of 12)`);
    for (const id of over) {
      const a = p0.assets.find((x) => x.id === `${id}_vo`)!;
      assert.ok(a.comments.some((c) => c.author === 'agent' && /^Audio runs [\d.]+ s; the shot is \d+ s$/.test(c.text)), `${id} is flagged when the take comes back`);
      assert.equal(a.status, 'pending-review', 'flagged, not changed');
    }
    for (const id of fit) assert.ok(!p0.assets.find((x) => x.id === `${id}_vo`)!.comments.some((c) => c.text.startsWith('Audio runs')));

    host.set(approve(host.peek(), voAssets(host.peek()).map((a) => a.id), 'sound').project);
    const res = await rebuildNarration({ host: g, readFile, now });
    assert.ok(res.status === 'built', JSON.stringify(res));
    assert.deepEqual(res.overrun.map((o) => o.shot).sort(), [...over].sort());
    for (const o of res.overrun) assert.ok(res.warnings.some((w) => w.includes(o.asset) && w.includes(o.shot) && /Audio runs [\d.]+ s; the shot is \d+ s/.test(w)));
    const p = host.peek();
    const n = p.audio.narration!;
    const { starts, durations } = shotStarts(p.shots);
    for (const id of fit) {
      const s = p.shots.find((x) => x.id === id)!;
      const mine = n.words.filter((w) => w.start_ms >= starts.get(id)! && w.end_ms <= starts.get(id)! + durations.get(id)!);
      assert.equal(mine.map((w) => w.word).join(' ').replace(/\s+/g, ' '), s.script_line!.trim().replace(/\s+/g, ' '));
    }
    for (const id of over) assert.equal(n.words.filter((w) => w.start_ms >= starts.get(id)! && w.start_ms < starts.get(id)! + durations.get(id)!).length, 0, `${id} left out`);
    assert.ok(res.captions && res.captions.cues > 0);
    assert.deepEqual(res.withoutTimings, []);
    console.log(`BEATING 70ms: ${over.length} of 12 overrun (${over.join(',')}); words built ${n.words.length}`);
  });
});
