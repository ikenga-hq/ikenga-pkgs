// WP-10 — the named short-story fixture (12 shots): run the free path up to approved key frames, plan
// motion, and check one clip job per shot through the gate. No network: the fal video provider gets a
// mocked fetch and nothing is ever sent (every job stops at the spend line).

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runShortStory } from '../fixtures/short-story/harness.ts';
import { createFalVideoProvider } from '../providers/fal-video/index.ts';
import { mockFalVideo } from '../providers/fal-video/__fixtures__/mock-net.ts';
import { PNG_BYTES } from '../providers/gemini-image/__fixtures__/mock-net.ts';
import { createFakeHost } from '../providers/__fixtures__/fake-host.ts';
import { createSpendGate } from '../spend/gate.ts';
import { buildMotionJob, clipAssets, planMotion } from './plan.ts';
import { generateClips } from './run.ts';

describe('short-story fixture: motion planning', () => {
  it('plans one clip per shot and builds one gated clip job for each; the first spend line shows the arithmetic', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'akuko-ss-motion-'));
    const ev = await runShortStory({ dir, provider: 'manual', upTo: 'keyframes' });
    assert.equal(ev.stageStates.keyframes, 'approved');

    const planned = planMotion(ev.final, '2026-11-09T10:00:00Z');
    assert.equal(planned.created.length, 12);
    assert.equal(clipAssets(planned.project).length, 12);

    const project = { ...planned.project, budget: { cap: 25, currency: 'USD', spent: 0 } };
    const net = mockFalVideo();
    const host = createFakeHost(project);
    const provider = createFalVideoProvider(host, { fetch: net.fetch, apiKey: 'test-key', loadRef: async () => ({ mime: 'image/png', data: PNG_BYTES }) });
    const gate = createSpendGate({ host, providers: [provider], level: 'B' });

    // one job per shot, each for exactly its own clip, each with its own id
    const ids = new Set<string>();
    for (const a of clipAssets(project)) {
      const b = buildMotionJob(project, { provider: 'fal-video', units: [a.id] });
      assert.deepEqual(b.units, [a.id]);
      assert.equal(b.job.items.length, 1);
      assert.equal(b.job.items[0]!.refs?.[0]?.role, 'start-frame');
      assert.ok(b.job.items[0]!.duration_s! >= project.shots.find((s) => s.id === a.owner)!.duration_s!, 'a clip is never shorter than its shot (default fit: cover)');
      ids.add(b.job.id);
    }
    assert.equal(ids.size, 12);

    // the first shot (6 s) through the gate: held at the spend line, nothing sent
    const step = await generateClips({ host, gate }, { provider: 'fal-video' });
    assert.equal(step.status, 'awaiting-approval');
    if (step.status !== 'awaiting-approval') return;
    assert.deepEqual(step.job.items.map((i) => i.unit), ['sc1_sh1_clip']);
    assert.match(step.confirmation, /sc1_sh1 10 s x 0\.07 USD\/s = 0\.7 \(10 s billed for a 6 s shot\)/);
    assert.match(step.confirmation, /Reply "approve 0\.7 USD"/);
    assert.equal(net.calls.length, 0);
  });
});
