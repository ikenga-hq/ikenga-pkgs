// com.ikenga.studio project sidecar · fal.ts model + output-kind resolution
//
//   bun run src/fal-model.test.ts   (from sidecars/project/)
//   bun run test                     (package script)
//
// Plain assert-based script — same constraint as registry.test.ts, see its header.
//
// Mode C makes THREE fal calls per shot and two of them are stills: FLUX
// inpaints the character into the start and end plates, then Kling O1
// interpolates between those two frames. The adapter was video-only, so a cell
// pointed at an inpaint endpoint would call it, BILL, and then fail extracting
// a video url from an image response.
//
// What matters here is that the kind is decided BEFORE the call — it picks the
// output extension, the response field to read, and (via the spend gate) the
// billing unit, which differs by an order of magnitude between per-megapixel
// and per-video-second.

import assert from 'node:assert/strict';

import { resolveFalModel, resolveFalDurationMs } from './renderers/fal.js';
import type { Cell } from '@ikenga/studio-schema';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

function cell(metadata: Record<string, unknown> = {}): Cell {
  return { uid: 'c1', metadata } as unknown as Cell;
}

// -- explicit declaration wins ---------------------------------------------

test('fal_output:"still" makes it a still, whatever the model looks like', () => {
  const r = resolveFalModel(cell({ fal_output: 'still', fal_model: 'fal-ai/flux-lora/inpainting' }), {});
  assert.equal(r.kind, 'still');
  assert.equal(r.model, 'fal-ai/flux-lora/inpainting');
});

test('fal_output:"video" overrides an inference that would have said still', () => {
  const r = resolveFalModel(cell({ fal_output: 'video', fal_model: 'fal-ai/flux-lora/inpainting' }), {});
  assert.equal(r.kind, 'video');
});

test('a still never takes the image-to-video auto-switch', () => {
  const r = resolveFalModel(cell({ fal_output: 'still' }), {}, { hasImage: true });
  assert.ok(!r.model.includes('image-to-video'), `got ${r.model}`);
});

// -- inference, when nothing is declared ------------------------------------

test('the inpaint endpoint infers as a still', () => {
  assert.equal(resolveFalModel(cell({ fal_model: 'fal-ai/flux-lora/inpainting' }), {}).kind, 'still');
});

test('the fill endpoint infers as a still', () => {
  assert.equal(resolveFalModel(cell({ fal_model: 'fal-ai/flux-pro/v1/fill' }), {}).kind, 'still');
});

test('seedream edit infers as a still', () => {
  assert.equal(
    resolveFalModel(cell({ fal_model: 'fal-ai/bytedance/seedream/v4/edit' }), {}).kind, 'still');
});

test('Kling O1 — the Mode C interpolator — infers as video', () => {
  const r = resolveFalModel(cell({ fal_model: 'fal-ai/kling-video/o1/image-to-video' }), {});
  assert.equal(r.kind, 'video');
});

test('an explicit *-to-video endpoint beats the family pattern', () => {
  assert.equal(resolveFalModel(cell({ fal_model: 'fal-ai/flux-video/image-to-video' }), {}).kind, 'video');
});

test('an unrecognised model stays video — the prior behaviour, so old cells are unaffected', () => {
  assert.equal(resolveFalModel(cell({ fal_model: 'fal-ai/some-new-thing' }), {}).kind, 'video');
});

test('no metadata at all resolves the video default', () => {
  const r = resolveFalModel(cell(), {});
  assert.equal(r.kind, 'video');
  assert.ok(r.model.startsWith('fal-ai/'));
});

test('a bare model name is owner-qualified', () => {
  assert.equal(resolveFalModel(cell({ fal_output: 'still', fal_model: 'schnell' }), {}).model,
               'fal-ai/schnell');
});

test('a value containing a slash passes through UNqualified — a known sharp edge', () => {
  // "has a slash" is the owner-qualified heuristic, inherited from the video
  // path and left consistent with it. It cannot tell `flux/schnell` (missing
  // its owner) from `fal-ai/flux/schnell` (correct), because the real id has
  // two slashes. Pinned here so the behaviour is recorded rather than
  // rediscovered: pass fal model ids in full.
  assert.equal(resolveFalModel(cell({ fal_output: 'still', fal_model: 'flux/schnell' }), {}).model,
               'flux/schnell');
});

// -- duration: what the gate prices ----------------------------------------
//
// Kling O1 bills per video-second, so this number IS the bill. Getting it from
// the cell's authored length instead of the request body was wrong in both
// directions -- see resolveFalDurationMs.

function durCell(metadata: Record<string, unknown>, duration_ms?: number): Cell {
  return { uid: 'c1', metadata, duration_ms } as unknown as Cell;
}

test('fal_input.duration wins -- it is what the model receives and fal bills', () => {
  // The observed case: a 6s cell trimmed to 5s produced a 5.08s clip while the
  // gate charged 6s.
  assert.equal(resolveFalDurationMs(durCell({ fal_input: { duration: '5' } }, 6000)), 5000);
});

test('a LONGER declared duration is honoured too -- the direction that costs money', () => {
  // The gate would previously have charged 5s for a 10s render, under-pricing
  // by half. A ceiling exists to catch exactly this.
  assert.equal(resolveFalDurationMs(durCell({ fal_input: { duration: 10 } }, 5000)), 10000);
});

test('an explicit range is used when no duration is declared', () => {
  assert.equal(
    resolveFalDurationMs(durCell({}, 6000), { range: { start_ms: 1000, end_ms: 4000 } }), 3000);
});

test('fal_input.duration outranks the range -- the body wins over the request', () => {
  assert.equal(
    resolveFalDurationMs(durCell({ fal_input: { duration: '8' } }, 6000),
                         { range: { start_ms: 0, end_ms: 3000 } }), 8000);
});

test('falls back to the cell length when nothing is declared', () => {
  assert.equal(resolveFalDurationMs(durCell({}, 6000)), 6000);
});

test('a garbage duration falls through rather than becoming a free render', () => {
  assert.equal(resolveFalDurationMs(durCell({ fal_input: { duration: 'abc' } }, 6000)), 6000);
  assert.equal(resolveFalDurationMs(durCell({ fal_input: { duration: 0 } }, 6000)), 6000);
  assert.equal(resolveFalDurationMs(durCell({ fal_input: { duration: -3 } }, 6000)), 6000);
});

test('no duration anywhere is undefined, so the estimator uses its own default', () => {
  assert.equal(resolveFalDurationMs(durCell({})), undefined);
});

console.log(`\n${passed} passed`);
