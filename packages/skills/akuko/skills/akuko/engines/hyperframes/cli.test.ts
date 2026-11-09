// WP-11 — HyperFrames wrapper with a mocked spawn: no Chrome, no FFmpeg, no network.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HYPERFRAMES_VERSION,
  HyperframesError,
  check,
  engineEnv,
  estimateRender,
  extractJson,
  lint,
  parseDuration,
  parseRenderSummary,
  quoteForCmd,
  render,
  renderArgs,
  resolveInvocation,
  secondsPerFrameFrom,
  snapshot,
  snapshotArgs,
  type SpawnFn,
  type SpawnResult,
} from './cli.ts';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

interface Call {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  shell: boolean;
}

function fakeSpawn(result: Partial<SpawnResult>): { spawn: SpawnFn; calls: Call[] } {
  const calls: Call[] = [];
  const spawn: SpawnFn = async (command, args, o) => {
    calls.push({ command, args, env: o.env, shell: o.shell });
    return { code: 0, stdout: '', stderr: '', ms: 1234, ...result };
  };
  return { spawn, calls };
}

describe('invocation', () => {
  it('runs a hyperframes.mjs path with this Node', () => {
    assert.deepEqual(resolveInvocation({ bin: '/x/hyperframes.mjs', platform: 'linux' }), {
      command: process.execPath, prefix: ['/x/hyperframes.mjs'], shell: false,
    });
  });

  it('defaults to the pinned version through npx, with a shell only for npx.cmd on Windows', () => {
    assert.deepEqual(resolveInvocation({ platform: 'linux' }), { command: 'npx', prefix: ['--yes', `hyperframes@${HYPERFRAMES_VERSION}`], shell: false });
    assert.deepEqual(resolveInvocation({ platform: 'win32', version: '0.9.26' }), { command: 'npx.cmd', prefix: ['--yes', 'hyperframes@0.9.26'], shell: true });
    assert.equal(HYPERFRAMES_VERSION, '0.9.19');
  });

  it('quotes arguments for cmd.exe only when needed', () => {
    assert.equal(quoteForCmd('lint'), 'lint');
    assert.equal(quoteForCmd('C:\\My Films\\scene 1'), '"C:\\My Films\\scene 1"');
    assert.equal(quoteForCmd('a"b'), '"a""b"');
    assert.equal(quoteForCmd(''), '""');
  });
});

describe('HYPERFRAMES_BROWSER_PATH on Windows', () => {
  it('passes the variable through untouched', () => {
    const { env, warnings } = engineEnv({ env: { HYPERFRAMES_BROWSER_PATH: CHROME, PATH: 'p' }, platform: 'win32' });
    assert.equal(env.HYPERFRAMES_BROWSER_PATH, CHROME);
    assert.equal(env.PATH, 'p');
    assert.deepEqual(warnings, []);
  });

  it('sets it from browserPath and warns when Windows has none', () => {
    assert.equal(engineEnv({ env: {}, browserPath: CHROME, platform: 'win32' }).env.HYPERFRAMES_BROWSER_PATH, CHROME);
    const w = engineEnv({ env: {}, platform: 'win32' }).warnings;
    assert.equal(w.length, 1);
    assert.match(w[0] ?? '', /HYPERFRAMES_BROWSER_PATH is not set/);
    assert.deepEqual(engineEnv({ env: {}, platform: 'darwin' }).warnings, []);
  });

  it('reaches the spawned render process', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: 'rendered in 48.2s' });
    await render('C:\\film\\scene', { output: 'C:\\film\\out.mp4' }, { spawn, env: { HYPERFRAMES_BROWSER_PATH: CHROME }, platform: 'win32', bin: 'C:\\hf\\bin\\hyperframes.mjs' });
    assert.equal(calls[0]?.env.HYPERFRAMES_BROWSER_PATH, CHROME);
    assert.equal(calls[0]?.shell, false);
  });

  it('quotes a Windows path with spaces when going through npx.cmd', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: '{"ok":true,"errorCount":0,"warningCount":0,"infoCount":0,"findings":[],"filesScanned":1}' });
    await lint('C:\\My Films\\index.html', { spawn, env: { HYPERFRAMES_BROWSER_PATH: CHROME }, platform: 'win32' });
    assert.equal(calls[0]?.command, 'npx.cmd');
    assert.deepEqual(calls[0]?.args, ['--yes', 'hyperframes@0.9.19', 'lint', '--json', '"C:\\My Films\\index.html"']);
  });
});

// Shapes copied from HyperFrames 0.9.19 output (trimmed).
const LINT_OUT = `{
  "ok": true, "errorCount": 0, "warningCount": 1, "infoCount": 0,
  "findings": [{ "code": "nested_structure_needs_subcomposition", "severity": "warning",
    "message": "<div id=\\"stage-clip\\"> is a timeline element that contains nested <div>.",
    "elementId": "stage-clip", "fixHint": "Move it into a sub-composition.", "file": "C:\\\\x\\\\index.html", "line": 238 }],
  "filesScanned": 1, "_meta": { "version": "0.9.19" }
}`;

const CHECK_OUT = `{
  "ok": true, "strict": false, "browserSkipped": false,
  "lint": { "ok": true, "errorCount": 0, "warningCount": 1, "infoCount": 0, "findings": [{ "code": "x", "severity": "warning", "message": "m", "sourceFile": "index.html" }], "filesScanned": 1 },
  "runtime": { "ok": true, "errorCount": 0, "warningCount": 0, "infoCount": 0, "findings": [] },
  "layout": { "ok": true, "errorCount": 0, "warningCount": 0, "infoCount": 1, "findings": [{ "code": "container_overflow", "severity": "info", "message": "Element extends outside a clipping layout container.", "selector": "#kb" }], "duration": 6 },
  "contrast": { "ok": false, "errorCount": 1, "warningCount": 0, "infoCount": 0, "findings": [{ "code": "low_contrast", "severity": "error", "message": "2.1:1" }] }
}`;

describe('lint and check', () => {
  it('parses lint findings', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: `notice\n${LINT_OUT}\n` });
    const r = await lint('blocks/stat.html', { spawn, bin: 'hf.mjs', platform: 'linux' });
    assert.deepEqual(calls[0]?.args, ['hf.mjs', 'lint', '--json', 'blocks/stat.html']);
    assert.equal(r.ok, true);
    assert.equal(r.warningCount, 1);
    assert.equal(r.filesScanned, 1);
    assert.deepEqual(r.findings[0], {
      code: 'nested_structure_needs_subcomposition', severity: 'warning',
      message: '<div id="stage-clip"> is a timeline element that contains nested <div>.',
      file: 'C:\\x\\index.html', fixHint: 'Move it into a sub-composition.',
    });
  });

  it('parses every check section and keeps the overall verdict', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: CHECK_OUT, code: 0 });
    const r = await check('blocks', { spawn, bin: 'hf.mjs', platform: 'linux' });
    assert.deepEqual(calls[0]?.args, ['hf.mjs', 'check', '--json', 'blocks']);
    assert.deepEqual(Object.keys(r.sections), ['lint', 'runtime', 'layout', 'contrast']);
    assert.equal(r.ok, true);
    assert.equal(r.sections.contrast?.ok, false);
    assert.equal(r.sections.layout?.findings[0]?.selector, '#kb');
    assert.equal(r.sections.lint?.findings[0]?.file, 'index.html');
  });

  it('throws a HyperframesError with the stderr tail when there is no JSON', async () => {
    const { spawn } = fakeSpawn({ code: 1, stderr: 'Error: Chrome crashed (0xC000007B)' });
    await assert.rejects(lint('x.html', { spawn, bin: 'hf.mjs', platform: 'linux' }), (e: unknown) => {
      assert.ok(e instanceof HyperframesError);
      assert.equal(e.code, 1);
      assert.match(e.stderr, /0xC000007B/);
      return true;
    });
  });

  it('extractJson tolerates notices around the document', () => {
    assert.deepEqual(extractJson('▲ update available\n{"a":{"b":1}}\n6 skills out of date'), { a: { b: 1 } });
    assert.throws(() => extractJson('no json'), SyntaxError);
  });
});

describe('snapshot (HyperFrames seek path)', () => {
  it('asks for exact times without the extra end frame', () => {
    assert.deepEqual(snapshotArgs('scene', { at: [0.5, 3], outDir: 'out' }), ['snapshot', 'scene', '--json', '--at', '0.5,3', '-o', 'out', '--no-end']);
    assert.deepEqual(snapshotArgs('scene', { frames: 8, end: true }), ['snapshot', 'scene', '--json', '--frames', '8', '--end']);
    assert.throws(() => snapshotArgs('scene', { at: [-1] }), RangeError);
  });

  it('returns the frame paths HyperFrames reports', async () => {
    const out = JSON.stringify({ ok: true, outputDir: 'out', frames: [{ path: 'out/frame-00-at-0.5s.png', time: 0.5 }], contactSheets: ['out/contact-sheet.jpg'] });
    const { spawn } = fakeSpawn({ stdout: out });
    const r = await snapshot('scene', { at: [0.5] }, { spawn, bin: 'hf.mjs', platform: 'linux' });
    assert.deepEqual(r.frames, [{ path: 'out/frame-00-at-0.5s.png', time: 0.5 }]);
    assert.deepEqual(r.contactSheets, ['out/contact-sheet.jpg']);
  });

  it('fails loudly when the snapshot run fails', async () => {
    const { spawn } = fakeSpawn({ code: 1, stdout: '{"ok":false}', stderr: 'composition never became ready' });
    await assert.rejects(snapshot('scene', {}, { spawn, bin: 'hf.mjs', platform: 'linux' }), /snapshot failed/);
  });
});

const RENDER_LOG = [
  '  █████████████████████████  100%  Render complete',
  '◇  C:\\film\\out.mp4',
  '   1.3 MB · 180 frames · rendered in 1m 22.9s',
  '   screenshot capture · hardware gpu · compile 3.6s · extract 0.0s · audio 0.0s · probe 0.6s · setup 26.5s · capture 47.1s · encode 0.7s',
  '@hf-result {"version":1,"operation":"render"}',
].join('\n');

describe('render', () => {
  it('final: delivery quality at the composition frame rate, strict lint', () => {
    assert.deepEqual(renderArgs('scene', { output: 'o.mp4' }), ['render', 'scene', '-o', 'o.mp4', '--format', 'mp4', '--quality', 'delivery', '--strict']);
  });

  it('draft: draft quality at 15 fps', () => {
    assert.deepEqual(renderArgs('scene', { output: 'o.mp4', profile: 'draft', workers: 2, composition: 'b.html', strict: false }), [
      'render', 'scene', '-o', 'o.mp4', '--format', 'mp4', '-c', 'b.html', '--quality', 'draft', '--fps', '15', '--workers', '2',
    ]);
  });

  it('parses the summary line', () => {
    assert.deepEqual(parseRenderSummary(RENDER_LOG), {
      frames: 180,
      renderedInSeconds: 82.9,
      pipeline: 'screenshot capture · hardware gpu · compile 3.6s · extract 0.0s · audio 0.0s · probe 0.6s · setup 26.5s · capture 47.1s · encode 0.7s',
    });
    assert.deepEqual(parseRenderSummary('nothing'), { frames: null, renderedInSeconds: null, pipeline: null });
    assert.equal(parseDuration('48.2s'), 48.2);
    assert.equal(parseDuration('1h 2m 3s'), 3723);
  });

  it('returns parsed results and throws on a failed render', async () => {
    const ok = fakeSpawn({ stderr: RENDER_LOG, ms: 90000 });
    const r = await render('scene', { output: 'o.mp4' }, { spawn: ok.spawn, bin: 'hf.mjs', platform: 'linux' });
    assert.equal(r.frames, 180);
    assert.equal(r.ms, 90000);
    const bad = fakeSpawn({ code: 1, stderr: 'lint errors: 2' });
    await assert.rejects(render('scene', { output: 'o.mp4' }, { spawn: bad.spawn, bin: 'hf.mjs', platform: 'linux' }), /render failed \(1\)/);
  });
});

describe('render-time estimate (R-10)', () => {
  it('frames × seconds per frame + setup, in plain words', () => {
    const e = estimateRender({ durationSeconds: 6, secondsPerFrame: 0.3, setupSeconds: 30 });
    assert.equal(e.frames, 180);
    assert.ok(Math.abs(e.seconds - 84) < 1e-9);
    assert.equal(e.text, 'about 84 s (180 frames)');
    assert.match(estimateRender({ durationSeconds: 70, secondsPerFrame: 0.3, setupSeconds: 30 }).text, /^about 11 min \(2100 frames\)$/);
  });

  it('draft halves the frames', () => {
    assert.equal(estimateRender({ durationSeconds: 6, profile: 'draft' }).frames, 90);
    assert.throws(() => estimateRender({ durationSeconds: 0 }), RangeError);
  });

  it('calibrates seconds per frame from a finished render', () => {
    assert.ok(Math.abs((secondsPerFrameFrom({ frames: 180, renderedInSeconds: 84 }, 30) ?? 0) - 0.3) < 1e-9);
    assert.equal(secondsPerFrameFrom({ frames: null, renderedInSeconds: 84 }), null);
  });
});
