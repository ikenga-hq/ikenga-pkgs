// com.ikenga.studio project sidecar · motion.test.ts (WP-14)
//
//   bun run src/renderers/remotion/conventions/motion.test.ts
//
// Tests for Remotion motion vocabulary and authoring helpers.

import assert from 'node:assert/strict';

import {
  applyOffset,
  bloom,
  interpolate,
  lag,
  lead,
  settle,
  snap,
  SPRINGS,
} from './motion/index.js';
import { splitSegments } from './primitives/HighlightWords.js';
import { defaultPalette, lofiPalette } from './theme/brand.js';

let passed = 0;

function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const FPS = 30;

// ── Palette tests ────────────────────────────────────────────────────────────

test('default and lofi palettes satisfy 8-key contract', () => {
  const requiredKeys = ['bg', 'surface', 'border', 'accent', 'highlight', 'textPri', 'textSec'] as const;
  for (const k of requiredKeys) {
    assert.ok(typeof defaultPalette[k] === 'string' && defaultPalette[k].length > 0);
    assert.ok(typeof lofiPalette[k] === 'string' && lofiPalette[k].length > 0);
  }
  assert.equal(lofiPalette.lofi, true);
  assert.equal(defaultPalette.lofi, undefined);
});

// ── Settle tests ─────────────────────────────────────────────────────────────

test('settle returns 0 before or at startAt, and settles near 1.0', () => {
  assert.equal(settle({ frame: 10, fps: FPS, startAt: 10 }), 0);
  assert.equal(settle({ frame: 5, fps: FPS, startAt: 10 }), 0);

  const at35 = settle({ frame: 45, fps: FPS, startAt: 10 });
  assert.ok(at35 > 0.95, `expected settle to be > 0.95 at +35 frames, got ${at35}`);
  assert.ok(Math.abs(at35 - 1.0) < 0.05);
});

test('settle progress is strictly monotonic during initial rise', () => {
  const f1 = settle({ frame: 5, fps: FPS, startAt: 0 });
  const f2 = settle({ frame: 10, fps: FPS, startAt: 0 });
  const f3 = settle({ frame: 15, fps: FPS, startAt: 0 });
  assert.ok(f2 > f1, 'frame 10 must exceed frame 5');
  assert.ok(f3 > f2, 'frame 15 must exceed frame 10');
});

// ── Snap tests ───────────────────────────────────────────────────────────────

test('snap rises faster than settle', () => {
  assert.equal(snap({ frame: 5, fps: FPS, startAt: 5 }), 0);
  assert.equal(snap({ frame: 2, fps: FPS, startAt: 5 }), 0);

  const snapAt15 = snap({ frame: 15, fps: FPS, startAt: 0 });
  const settleAt15 = settle({ frame: 15, fps: FPS, startAt: 0 });
  assert.ok(snapAt15 >= settleAt15, 'snap should reach higher or equal progress than heavy settle at frame 15');
});

// ── Bloom tests ──────────────────────────────────────────────────────────────

test('bloom exhibits bouncy overshoot above 1.0', () => {
  assert.equal(bloom({ frame: 0, fps: FPS, startAt: 0 }), 0);

  let hasOvershoot = false;
  for (let f = 1; f <= 30; f++) {
    const val = bloom({ frame: f, fps: FPS, startAt: 0 });
    if (val > 1.0) {
      hasOvershoot = true;
      break;
    }
  }
  assert.ok(hasOvershoot, 'bloom should overshoot 1.0');
});

// ── Timing offsets (lag / lead / applyOffset) ────────────────────────────────

test('lag converts ms to positive frame offsets', () => {
  assert.equal(lag(200).offsetFrames(30), 6);
  assert.equal(lag(200).offsetFrames(60), 12);
  assert.equal(lag(100).offsetFrames(30), 3);
  assert.equal(lag(0).offsetFrames(30), 0);
});

test('lead converts ms to negative frame offsets', () => {
  assert.equal(lead(200).offsetFrames(30), -6);
  assert.equal(lead(200).offsetFrames(60), -12);
  assert.equal(lead(0).offsetFrames(30), 0);
});

test('applyOffset shifts frame and clamps to zero', () => {
  assert.equal(applyOffset(40, lag(200), 30), 46);
  assert.equal(applyOffset(40, lead(200), 30), 34);
  assert.equal(applyOffset(5, lead(300), 30), 0); // 5 - 9 = -4 -> 0
});

// ── HighlightWords splitSegments ─────────────────────────────────────────────

test('splitSegments preserves whitespace around matched phrases', () => {
  const text = 'Run an audit on my catalog splits';
  const segments = splitSegments(text, ['audit']);
  assert.deepEqual(segments, [
    { content: 'Run an ', highlight: false },
    { content: 'audit', highlight: true },
    { content: ' on my catalog splits', highlight: false },
  ]);
});

test('splitSegments prioritizes longer phrases first and handles case-insensitivity', () => {
  const text = 'Check the Royalty Statement now';
  const segments = splitSegments(text, ['royalty', 'royalty statement']);
  assert.deepEqual(segments, [
    { content: 'Check the ', highlight: false },
    { content: 'Royalty Statement', highlight: true },
    { content: ' now', highlight: false },
  ]);
});

console.log(`\n${passed} passed`);
