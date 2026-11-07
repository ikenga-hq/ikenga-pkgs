// Freeform storyboard → akuko.json import: comments and per-rung status
// must come across; nothing is dropped silently.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AkukoProjectSchema } from './akuko-project.ts';
import { FreeformConversionError, fromFreeform } from './convert/freeform.ts';
import { checkIntegrity } from './integrity.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const freeform = JSON.parse(readFileSync(join(HERE, '__fixtures__', 'freeform-storyboard.json'), 'utf8'));
const NOW = '2026-11-07T12:00:00.000Z';

describe('freeform storyboard import', () => {
  const p = fromFreeform(freeform, { now: NOW });
  const [hook, roots, canopy] = p.shots;

  it('produces a schema-valid, internally consistent akuko project', () => {
    assert.equal(AkukoProjectSchema.safeParse(p).success, true);
    assert.deepEqual(checkIntegrity(p), []);
    assert.equal(p.project.slug, 'seed-to-tree');
    assert.equal(p.project.created_at, NOW);
    assert.equal(p.project.profile, 'explainer');
  });

  it('makes one shot per beat, at the current rung\'s stage', () => {
    assert.deepEqual(p.shots.map((s) => s.id), ['hook', 'roots', 'canopy']);
    assert.equal(p.current_stage, 'sketch', 'current_rung 1 is the sketch stage');
    for (const s of p.shots) assert.equal(s.stage, 'sketch');
  });

  it('imports per-rung status into by_stage and the current rung\'s status as the shot status', () => {
    assert.equal(hook?.status, 'approved');
    assert.equal(roots?.status, 'needs-rework');
    assert.equal(canopy?.status, 'pending-review');
    assert.deepEqual(hook?.by_stage, {
      breakdown: { status: 'approved', content: "Acorn on soil; title lands on 'small'." },
      sketch: { status: 'approved', output: { uri: 'compositions/seed-to-tree/stills/hook-1_lofi.png' } },
      keyframes: { status: 'pending' },
    });
    assert.deepEqual(canopy?.by_stage, {
      breakdown: { status: 'approved' },
      sketch: { status: 'pending-review', output: { uri: 'compositions/seed-to-tree/stills/canopy-1_lofi.png' } },
    }, 'a rung the beat has not reached is absent, not invented');
  });

  it('derives the rung stages\' states from beat statuses', () => {
    assert.equal(p.stages.breakdown.state, 'approved');
    assert.equal(p.stages.sketch.state, 'in-review');
    assert.equal(p.stages.keyframes.state, 'not-started');
    assert.equal(p.stages.intake.state, 'not-started');
  });

  it('imports comments with ISO timestamps and the stage of their rung', () => {
    assert.deepEqual(hook?.comments, [
      { ts: '2025-05-01T10:00:00.000Z', stage: 'breakdown', author: 'unknown', text: 'Lead with the acorn, not the title.' },
      { ts: '2025-05-01T11:00:00.000Z', stage: 'breakdown', author: 'unknown', text: 'Revised: acorn first, title on the last word.' },
    ]);
    assert.deepEqual(roots?.comments, [
      { ts: '2025-05-02T10:00:00.000Z', stage: 'sketch', author: 'unknown', text: 'Root line reads as a crack. Make it branch.' },
    ]);
    assert.deepEqual(canopy?.comments, []);
  });

  it('maps beat text and timing, and keeps the rest in the freeform slot', () => {
    assert.equal(hook?.label, 'Hook');
    assert.equal(hook?.narration, 'Every oak starts small.');
    assert.equal(hook?.intent, 'Single acorn on bare soil, slow push.');
    assert.equal(roots?.duration_s, 3.5);
    assert.equal(canopy?.narration, null);
    assert.deepEqual(hook?.freeform, {
      time: { start: 0, end: 3 },
      frames: { start: 0, end: 90 },
      rung_extra: { '1_lofi': { tsx_anchor: 'src/compositions/SeedToTreeClipVideo.tsx:41' } },
    });
    assert.deepEqual(canopy?.freeform, { time: { start: 6.5, end: 9 }, extra: { music_cue: 'swell' } });
    assert.deepEqual(p.freeform, { extra: { selected_concepts: [{ filename: 'concept-b.png', role: 'palette' }] } });
  });

  it('imports narration with word timings', () => {
    assert.deepEqual(p.audio.narration, {
      audio: { uri: 'public/seed-to-tree/narration.mp3' },
      words: freeform.narration.words,
      voice_id: 'narrator-warm',
      duration_ms: 9000,
      generated_at: '2026-05-01T10:00:00.000Z',
    });
  });

  it('fills narration duration and time when the storyboard leaves them out', () => {
    const { duration_ms: _d, generated_at: _g, ...narration } = freeform.narration;
    const q = fromFreeform({ ...freeform, narration }, { now: NOW });
    assert.equal(q.audio.narration?.duration_ms, 1650);
    assert.equal(q.audio.narration?.generated_at, NOW);
  });

  it('keeps a narration block it cannot map whole, instead of dropping it', () => {
    const odd = { words: [], provider_job: 'abc' };
    const q = fromFreeform({ ...freeform, narration: odd }, { now: NOW });
    assert.equal(q.audio.narration, undefined);
    assert.deepEqual(q.freeform?.extra.narration, odd);
  });

  it('rejects input that is not a freeform storyboard', () => {
    assert.throws(() => fromFreeform({ slug: 'x', title: 'x' }), FreeformConversionError);
    const badStatus = structuredClone(freeform);
    badStatus.beats[0].rungs['1_lofi'].status = 'done';
    assert.throws(() => fromFreeform(badStatus), FreeformConversionError);
  });
});
