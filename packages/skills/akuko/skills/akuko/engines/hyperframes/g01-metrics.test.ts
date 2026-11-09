// WP-11 — pure parts of the G-01 harness: PSNR parsing, the text/state check, the pass/fail rule.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  G01_REGIONS,
  G01_THRESHOLDS,
  G01_TIMES,
  G01_FPS,
  expectedCaption,
  expectedCounter,
  frameIndexFor,
  inkIoU,
  judgePair,
  judgeSet,
  makeOnUpdateVariant,
  parsePsnr,
  parseReferenceBackground,
  pngSequenceName,
  psnr8,
  type PairResult,
} from './g01-metrics.ts';

const here = dirname(fileURLToPath(import.meta.url));

describe('parsePsnr', () => {
  it('reads the summary line FFmpeg prints for an RGB comparison', () => {
    const stderr = [
      'Input #0, png_pipe, from a.png:',
      '[Parsed_psnr_2 @ 000001] PSNR r:44.064184 g:47.775914 b:42.306042 average:44.174922 min:44.174922 max:44.174922',
    ].join('\r\n');
    assert.deepEqual(parsePsnr(stderr), {
      r: 44.064184, g: 47.775914, b: 42.306042, average: 44.174922, min: 44.174922, max: 44.174922,
    });
  });

  it('reads inf for identical frames and YUV channel names', () => {
    const p = parsePsnr('[Parsed_psnr_0 @ 0x1] PSNR y:inf u:inf v:inf average:inf min:inf max:inf');
    assert.equal(p?.average, Number.POSITIVE_INFINITY);
  });

  it('returns null when there is no summary line', () => {
    assert.equal(parsePsnr('Error opening input file a.png.'), null);
  });
});

describe('psnr8', () => {
  it('is Infinity for identical buffers and matches the textbook formula otherwise', () => {
    const a = new Uint8Array([10, 20, 30, 40]);
    assert.equal(psnr8(a, a), Number.POSITIVE_INFINITY);
    const b = new Uint8Array([11, 20, 30, 40]); // MSE = 1/4
    assert.ok(Math.abs(psnr8(a, b) - 10 * Math.log10((255 * 255) / 0.25)) < 1e-9);
  });

  it('rejects mismatched sizes', () => {
    assert.throws(() => psnr8(new Uint8Array(2), new Uint8Array(3)), /size mismatch/);
  });
});

describe('inkIoU (text/state check)', () => {
  it('is 1 for the same glyphs and for two empty regions', () => {
    const glyph = new Uint8Array([0, 255, 255, 0, 0, 200, 0, 0]);
    assert.equal(inkIoU(glyph, glyph).iou, 1);
    assert.equal(inkIoU(new Uint8Array(8), new Uint8Array(8)).iou, 1);
  });

  it('drops when the ink moves (a different digit or caption)', () => {
    const zero = new Uint8Array([0, 255, 255, 0, 0, 0, 0, 0]);
    const twenty = new Uint8Array([255, 255, 0, 0, 255, 255, 255, 0]);
    const r = inkIoU(zero, twenty);
    assert.equal(r.inkA, 2);
    assert.equal(r.inkB, 5);
    assert.ok(r.iou < 0.5);
  });

  it('ignores anti-aliasing that stays on the same side of the threshold', () => {
    const a = new Uint8Array([10, 240, 250, 20]);
    const b = new Uint8Array([30, 230, 255, 5]);
    assert.equal(inkIoU(a, b).iou, 1);
  });
});

const pair = (over: Partial<PairResult> = {}): PairResult => ({
  time: 3,
  framePsnrDb: 44,
  regions: [{ name: 'counter', iou: 0.99, psnrDb: 40 }, { name: 'caption', iou: 0.98, psnrDb: 41 }],
  ...over,
});

describe('judgePair / judgeSet (the G-01 bar)', () => {
  it('keeps the bar from the plan: 35 dB and ink IoU 0.95', () => {
    assert.deepEqual({ ...G01_THRESHOLDS }, { framePsnrDb: 35, inkIoU: 0.95 });
  });

  it('passes a pair over both bars', () => {
    assert.deepEqual(judgePair(pair()), { pass: true, psnrOk: true, textOk: true, reasons: [] });
  });

  it('fails on PSNR alone (the spike: 24.7–28.4 dB)', () => {
    const v = judgePair(pair({ framePsnrDb: 28.43 }));
    assert.equal(v.pass, false);
    assert.equal(v.textOk, true);
    assert.match(v.reasons[0] ?? '', /28\.43 < 35/);
  });

  it('fails on text alone even when PSNR is high (a counter can change few pixels)', () => {
    const v = judgePair(pair({ regions: [{ name: 'counter', iou: 0.31, psnrDb: 22 }, { name: 'caption', iou: 1, psnrDb: 50 }] }));
    assert.equal(v.pass, false);
    assert.equal(v.psnrOk, true);
    assert.match(v.reasons.join(), /counter ink IoU 0\.310/);
  });

  it('fails a NaN measurement and a pair with no text regions', () => {
    assert.equal(judgePair(pair({ regions: [{ name: 'counter', iou: Number.NaN, psnrDb: 0 }] })).pass, false);
    assert.equal(judgePair(pair({ regions: [] })).pass, false);
  });

  it('a set passes only when every pair passes', () => {
    assert.deepEqual(judgeSet([pair(), pair({ time: 4.5 })]), { pass: true, failedTimes: [] });
    assert.deepEqual(judgeSet([pair(), pair({ time: 4.5, framePsnrDb: 20 })]), { pass: false, failedTimes: [4.5] });
    assert.equal(judgeSet([]).pass, false);
  });
});

describe('frame bookkeeping', () => {
  it('maps the five probe times to exact 30 fps frames', () => {
    assert.deepEqual(G01_TIMES.map((t) => frameIndexFor(t, G01_FPS)), [15, 45, 90, 135, 177]);
    assert.throws(() => frameIndexFor(0.51, 30), /not on a 30 fps frame/);
  });

  it('names PNG-sequence frames the way HyperFrames 0.9.19 writes them (1-based)', () => {
    assert.equal(pngSequenceName(0), 'frame_000001.png');
    assert.equal(pngSequenceName(177), 'frame_000178.png');
  });

  it('reads the reference ground from the @hf-result line', () => {
    const out = 'rendered in 1m 22.9s\n@hf-result {"version":1,"operation":"render","reference_background":{"kind":"solid","rgb":[13,11,10]}}\n';
    assert.equal(parseReferenceBackground(out), '0x0D0B0A');
    assert.equal(parseReferenceBackground('@hf-result {"version":1,"reference_background":{"kind":"gradient"}}'), null);
    assert.equal(parseReferenceBackground('no result line'), null);
  });

  it('text regions sit inside the 1920x1080 frame', () => {
    for (const r of G01_REGIONS) {
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1920 && r.y + r.h <= 1080, r.name);
    }
  });
});

describe('expected state (mirrors g01/index.html)', () => {
  it('counter climbs 0 -> 20 from 0.3 s to 2.1 s and holds', () => {
    assert.deepEqual(G01_TIMES.map(expectedCounter), [6, 19, 20, 20, 20]);
    assert.equal(expectedCounter(0), 0);
  });

  it('one caption phrase is on screen at each probe time', () => {
    assert.deepEqual(G01_TIMES.map(expectedCaption), [1, 1, 2, 3, 3]);
  });
});

describe('makeOnUpdateVariant (negative control)', () => {
  it('swaps only the counter block of the committed composition', async () => {
    const html = await readFile(join(here, 'g01', 'index.html'), 'utf8');
    const nc = makeOnUpdateVariant(html);
    assert.match(nc, /onUpdate: function \(\) \{ numEl\.textContent = Math\.round\(counter\.val\); \}/);
    assert.doesNotMatch(nc, /set t\(time\)/);
    const strip = (s: string) => s.replace(/\/\* COUNTER:BEGIN[\s\S]*?COUNTER:END \*\//, '');
    assert.equal(strip(nc), strip(html));
  });

  it('refuses a composition without the marked block', () => {
    assert.throws(() => makeOnUpdateVariant('<html></html>'), /not found/);
  });
});

describe('g01 composition rules', () => {
  it('uses only vendored fonts and HyperFrames-served GSAP', async () => {
    const html = await readFile(join(here, 'g01', 'index.html'), 'utf8');
    assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/);
    const faces = [...html.matchAll(/url\("fonts\/([^"]+)"\)/g)].map((m) => m[1]);
    assert.ok(faces.length >= 3);
    const vendored = new Set((await import('node:fs')).readdirSync(join(here, '..', '..', 'blocks', 'fonts')));
    for (const f of faces) assert.ok(vendored.has(f as string), `${f} is vendored in blocks/fonts`);
    assert.match(html, /https:\/\/cdn\.jsdelivr\.net\/npm\/gsap@3\.15\.0\/dist\/gsap\.min\.js/);
  });
});
