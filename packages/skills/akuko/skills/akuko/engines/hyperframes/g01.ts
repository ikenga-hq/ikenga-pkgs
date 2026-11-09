// G-01 harness: does what a person approves in the HyperFrames preview equal what HyperFrames renders?
//
// Needs Chrome, FFmpeg and a HyperFrames install, so CI never runs it (it is not a *.test.ts).
// The measurement and the pass/fail rule live in g01-metrics.ts and are unit-tested.
//
//   node --experimental-strip-types engines/hyperframes/g01.ts \
//     --hf <path to node_modules/hyperframes/bin/hyperframes.mjs> --out <empty scratch dir>
//   (Windows: set HYPERFRAMES_BROWSER_PATH to system Chrome first; see G-01.md.)
//
// Steps (all outputs under --out, nothing written into the repo):
//   1. stage   work/g01 (the composition + blocks/fonts as fonts/), work/nc-onupdate (same
//              composition, counter swapped for the spike's onUpdate-only one) and work/nc-chip
//              (same composition, the 3 s caption chip reads "Step 3" instead of "Step 2").
//   2. preview `hyperframes snapshot --at <times> --no-end` (HyperFrames' own seek path).
//   3. render  `hyperframes render --format png-sequence` (lossless reference frames).
//   4. control hand-rolled previews the way the spike took them (plain Chrome, tl.seek(t)),
//              one with the onUpdate counter, one with the vendored fonts blocked.
//   5. compare whole-frame PSNR (FFmpeg psnr filter) + ink IoU and max |Δ luma| in the text
//              regions, per pair.
//   6. report  results.json, results.md, SHA256SUMS. Exit 0 only when G-01 passes AND all
//              three negative controls fail.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  G01_FPS,
  G01_REGIONS,
  G01_THRESHOLDS,
  G01_TIMES,
  expectedCaption,
  expectedCounter,
  fmtDb,
  frameIndexFor,
  inkIoU,
  judgePair,
  judgeSet,
  makeChipVariant,
  makeOnUpdateVariant,
  maxAbsDelta,
  parsePsnr,
  parseReferenceBackground,
  pngSequenceName,
  psnr8,
  type PairResult,
  type Region,
} from './g01-metrics.ts';
import { GSAP_URL } from './blocks.ts';
import { HYPERFRAMES_GSAP_VERSION } from './cli.ts';

const here = dirname(fileURLToPath(import.meta.url));
const akukoRoot = resolve(here, '..', '..');

interface Args {
  hf: string;
  out: string;
  browser: string | undefined;
  /** Reuse HyperFrames snapshots/renders already in --out (re-runs only the controls and the comparison). */
  reuse: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const hf = get('--hf') ?? process.env.HYPERFRAMES_BIN;
  const out = get('--out');
  if (!hf || !out) {
    console.error('usage: g01.ts --hf <hyperframes.mjs> --out <dir> [--browser <chrome.exe>] [--reuse]');
    process.exit(2);
  }
  return { hf: resolve(hf), out: resolve(out), browser: get('--browser') ?? process.env.HYPERFRAMES_BROWSER_PATH, reuse: argv.includes('--reuse') };
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<RunResult> {
  const started = performance.now();
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { env, cwd, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', fail);
    child.on('close', (code) =>
      ok({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        ms: performance.now() - started,
      }),
    );
  });
}

function runBuffer(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', fail);
    child.on('close', (code) =>
      code === 0 ? ok(Buffer.concat(out)) : fail(new Error(`${cmd} ${args.join(' ')} -> ${code}\n${Buffer.concat(err)}`)),
    );
  });
}

// ---------------------------------------------------------------- staging

async function stage(out: string): Promise<{ g01: string; nc: string; chip: string }> {
  const src = await readFile(join(here, 'g01', 'index.html'), 'utf8');
  const fontsSrc = join(akukoRoot, 'blocks', 'fonts');
  const fonts = (await readdir(fontsSrc)).filter((f) => f.endsWith('.woff2'));
  const make = async (name: string, html: string): Promise<string> => {
    const dir = join(out, 'work', name);
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, 'fonts'), { recursive: true });
    await writeFile(join(dir, 'index.html'), html, 'utf8');
    for (const f of fonts) await copyFile(join(fontsSrc, f), join(dir, 'fonts', f));
    return dir;
  };
  return {
    g01: await make('g01', src),
    nc: await make('nc-onupdate', makeOnUpdateVariant(src)),
    chip: await make('nc-chip', makeChipVariant(src)),
  };
}

// ---------------------------------------------------------------- HyperFrames runs

async function hfSnapshot(a: Args, env: NodeJS.ProcessEnv, project: string, outDir: string): Promise<{ files: string[]; ms: number; log: string }> {
  const saved = `${outDir}.json`;
  if (a.reuse && existsSync(saved)) return JSON.parse(await readFile(saved, 'utf8')) as { files: string[]; ms: number; log: string };
  await rm(outDir, { recursive: true, force: true });
  const r = await run(
    process.execPath,
    [a.hf, 'snapshot', project, '--at', G01_TIMES.join(','), '--no-end', '-o', outDir, '--json'],
    env,
    project,
  );
  if (r.code !== 0) throw new Error(`snapshot failed (${r.code})\n${r.stderr}\n${r.stdout}`);
  const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'), r.stdout.lastIndexOf('}') + 1)) as {
    frames: { path: string; time: number }[];
  };
  const files = G01_TIMES.map((t) => {
    const f = json.frames.find((x) => Math.abs(x.time - t) < 1e-9);
    if (!f) throw new Error(`snapshot did not return t=${t}`);
    return f.path;
  });
  const result = { files, ms: r.ms, log: r.stderr };
  await writeFile(saved, JSON.stringify(result), 'utf8');
  return result;
}

async function hfRenderPngs(a: Args, env: NodeJS.ProcessEnv, project: string, outDir: string): Promise<{ dir: string; background: string; ms: number; log: string }> {
  const saved = `${outDir}.json`;
  if (a.reuse && existsSync(saved)) return JSON.parse(await readFile(saved, 'utf8')) as { dir: string; background: string; ms: number; log: string };
  await rm(outDir, { recursive: true, force: true });
  const r = await run(process.execPath, [a.hf, 'render', project, '--format', 'png-sequence', '-o', outDir], env, project);
  const log = `${r.stdout}\n${r.stderr}`;
  if (r.code !== 0) throw new Error(`render failed (${r.code})\n${log}`);
  const background = parseReferenceBackground(log);
  if (!background) throw new Error('render did not report a solid reference_background on its @hf-result line');
  const result = { dir: outDir, background, ms: r.ms, log };
  await writeFile(saved, JSON.stringify(result), 'utf8');
  return result;
}

// ---------------------------------------------------------------- hand-rolled control capture

interface PuppeteerPage {
  setViewport(v: { width: number; height: number; deviceScaleFactor: number }): Promise<void>;
  setRequestInterception(on: boolean): Promise<void>;
  on(event: 'request', fn: (req: PuppeteerRequest) => void): void;
  on(event: 'pageerror', fn: (err: unknown) => void): void;
  goto(url: string, o: { waitUntil: string; timeout: number }): Promise<unknown>;
  waitForFunction(fn: string, o: { timeout: number }): Promise<unknown>;
  evaluate(fn: string): Promise<unknown>;
  screenshot(o: { path: string }): Promise<unknown>;
}
interface PuppeteerRequest {
  url(): string;
  continue(): Promise<void>;
  abort(): Promise<void>;
  respond(r: { status: number; contentType: string; body: Buffer }): Promise<void>;
}
interface PuppeteerBrowser {
  newPage(): Promise<PuppeteerPage>;
  close(): Promise<void>;
}
interface PuppeteerModule {
  launch(o: Record<string, unknown>): Promise<PuppeteerBrowser>;
}

const GSAP_CDN = GSAP_URL;

/** HyperFrames' vendored copy of the GSAP the compositions name; throws if this install lacks it. */
function vendoredGsap(hf: string): string {
  const file = join(dirname(hf), '..', 'dist', 'vendor', 'npm', `gsap@${HYPERFRAMES_GSAP_VERSION}`, 'dist', 'gsap.min.js');
  if (!existsSync(file)) throw new Error(`this HyperFrames does not vendor gsap@${HYPERFRAMES_GSAP_VERSION} (${file}); renders would fetch GSAP from the network`);
  return file;
}
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2' };

async function loadPuppeteer(hf: string): Promise<PuppeteerModule> {
  const req = createRequire(join(dirname(hf), '..', 'package.json'));
  const mod = (await import(pathToFileURL(req.resolve('puppeteer-core')).href)) as { default?: PuppeteerModule } & PuppeteerModule;
  return mod.default ?? mod;
}

/**
 * The spike's capture, reproduced on purpose as the negative control: plain Chrome, raw HTML
 * (no HyperFrames compile), `window.__timelines.main.seek(t)` (GSAP suppresses callbacks on
 * seek by default), two animation frames, screenshot. Fonts are awaited unless `blockFonts`.
 */
async function handRolledCapture(a: Args, project: string, outDir: string, blockFonts: boolean): Promise<string[]> {
  if (!a.browser) throw new Error('hand-rolled capture needs --browser or HYPERFRAMES_BROWSER_PATH');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const gsapFile = vendoredGsap(a.hf);
  const gsap = await readFile(gsapFile);
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const file = join(project, p === '/' ? 'index.html' : p);
    if (!file.startsWith(project) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as { port: number }).port;
  const puppeteer = await loadPuppeteer(a.hf);
  const browser = await puppeteer.launch({
    executablePath: a.browser,
    headless: true,
    args: ['--no-sandbox', '--window-size=1920,1080', '--force-device-scale-factor=1', '--use-gl=angle', '--use-angle=d3d11'],
  });
  const files: string[] = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => console.error(`[g01] page error: ${String(e)}`));
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      const url = r.url();
      if (url === GSAP_CDN) void r.respond({ status: 200, contentType: 'text/javascript', body: gsap });
      else if (blockFonts && url.endsWith('.woff2')) void r.abort();
      else void r.continue();
    });
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForFunction('!!(window.__timelines && window.__timelines.main)', { timeout: 30000 });
    await page.evaluate('document.fonts.ready.then(() => document.fonts.status)');
    for (const t of G01_TIMES) {
      await page.evaluate(`void window.__timelines.main.seek(${t})`); // seek() returns the timeline; don't serialise it
      await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
      const path = join(outDir, `at-${t}s.png`);
      await page.screenshot({ path });
      files.push(path);
    }
  } finally {
    await browser.close();
    server.close();
  }
  return files;
}

// ---------------------------------------------------------------- comparison

/** Reference frame as an opaque RGB PNG: composite the RGBA frame over HyperFrames' declared ground. */
async function flattenReference(refDir: string, index: number, background: string, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const src = join(refDir, pngSequenceName(index));
  const dst = join(outDir, `ref-${pngSequenceName(index)}`);
  await runBuffer('ffmpeg', [
    '-v', 'error', '-y', '-i', src, '-f', 'lavfi', '-i', `color=c=${background}:s=1920x1080`,
    '-lavfi', '[1:v][0:v]overlay=shortest=1:format=rgb,format=rgb24', '-frames:v', '1', dst,
  ]);
  return dst;
}

async function framePsnr(a: string, b: string): Promise<number> {
  const r = await run('ffmpeg', ['-hide_banner', '-i', a, '-i', b, '-lavfi', '[0:v]format=rgb24[a];[1:v]format=rgb24[b];[a][b]psnr', '-f', 'null', '-'], process.env);
  const p = parsePsnr(r.stderr);
  if (!p) throw new Error(`no PSNR line for ${a} vs ${b}\n${r.stderr}`);
  return p.average;
}

function grayRegion(file: string, r: Region): Promise<Buffer> {
  return runBuffer('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=${r.w}:${r.h}:${r.x}:${r.y},format=gray`, '-f', 'rawvideo', '-']);
}

async function comparePair(time: number, preview: string, reference: string): Promise<PairResult> {
  const regions = [];
  for (const r of G01_REGIONS) {
    const [ga, gb] = await Promise.all([grayRegion(preview, r), grayRegion(reference, r)]);
    regions.push({ name: r.name, iou: inkIoU(ga, gb).iou, psnrDb: psnr8(ga, gb), maxDelta: maxAbsDelta(ga, gb) });
  }
  return { time, framePsnrDb: await framePsnr(preview, reference), regions };
}

interface SetReport {
  id: string;
  what: string;
  expect: 'pass' | 'fail' | 'info';
  pairs: (PairResult & { preview: string; reference: string; verdict: ReturnType<typeof judgePair> })[];
  pass: boolean;
}

async function compareSet(id: string, what: string, expect: SetReport['expect'], previews: string[], refs: string[], times: readonly number[] = G01_TIMES): Promise<SetReport> {
  const pairs: SetReport['pairs'] = [];
  for (let i = 0; i < times.length; i++) {
    const p = await comparePair(times[i] as number, previews[i] as string, refs[i] as string);
    pairs.push({ ...p, preview: previews[i] as string, reference: refs[i] as string, verdict: judgePair(p) });
  }
  return { id, what, expect, pairs, pass: judgeSet(pairs).pass };
}

// ---------------------------------------------------------------- report

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function table(set: SetReport, out: string): string {
  const rows = set.pairs.map((p) => {
    const c = p.regions.find((r) => r.name === 'counter');
    const k = p.regions.find((r) => r.name === 'caption');
    return `| ${p.time.toFixed(1)} | ${frameIndexFor(p.time, G01_FPS)} | ${expectedCounter(p.time)} / ${expectedCaption(p.time) || '—'} | ${fmtDb(p.framePsnrDb)} | ${c?.iou.toFixed(3)} / ${c?.maxDelta} (${fmtDb(c?.psnrDb ?? Number.NaN)} dB) | ${k?.iou.toFixed(3)} / ${k?.maxDelta} (${fmtDb(k?.psnrDb ?? Number.NaN)} dB) | ${p.verdict.pass ? 'pass' : `**fail**: ${p.verdict.reasons.join('; ')}`} |`;
  });
  return [
    `### ${set.id} — ${set.what}`,
    '',
    `Expected: **${set.expect}** · Result: **${set.pass ? 'pass' : 'fail'}** · previews in \`${relative(out, dirname(set.pairs[0]?.preview ?? out)).replaceAll('\\', '/')}\``,
    '',
    '| t (s) | frame | expected counter / caption | frame PSNR (dB) | counter ink IoU / max Δluma (region PSNR) | caption ink IoU / max Δluma (region PSNR) | pair |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  await mkdir(a.out, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (a.browser) env.HYPERFRAMES_BROWSER_PATH = a.browser;
  const log = (m: string) => console.log(`[g01] ${m}`);

  vendoredGsap(a.hf); // fail fast when this HyperFrames does not vendor the GSAP the compositions name
  log('staging compositions');
  const work = await stage(a.out);

  log('g01: HyperFrames snapshot (preview)');
  const g01Preview = await hfSnapshot(a, env, work.g01, join(a.out, 'g01', 'preview-hf'));
  log('g01: HyperFrames render --format png-sequence (reference)');
  const g01Ref = await hfRenderPngs(a, env, work.g01, join(a.out, 'g01', 'ref'));
  log('nc-onupdate: HyperFrames snapshot');
  const ncPreview = await hfSnapshot(a, env, work.nc, join(a.out, 'nc-onupdate', 'preview-hf'));
  log('nc-onupdate: HyperFrames render');
  const ncRef = await hfRenderPngs(a, env, work.nc, join(a.out, 'nc-onupdate', 'ref'));
  log('nc-chip: HyperFrames snapshot');
  const chipPreview = await hfSnapshot(a, env, work.chip, join(a.out, 'nc-chip', 'preview-hf'));
  log('controls: hand-rolled captures');
  const ncHand = await handRolledCapture(a, work.nc, join(a.out, 'nc-onupdate', 'preview-handrolled'), false);
  const g01NoFonts = await handRolledCapture(a, work.g01, join(a.out, 'g01', 'preview-handrolled-nofonts'), true);
  const g01Hand = await handRolledCapture(a, work.g01, join(a.out, 'g01', 'preview-handrolled'), false);

  log('flattening reference frames');
  const flat = async (ref: typeof g01Ref, dir: string, times: readonly number[], shift = 0) => {
    const files: string[] = [];
    for (const t of times) files.push(await flattenReference(ref.dir, frameIndexFor(t, G01_FPS) + shift, ref.background, dir));
    return files;
  };
  const g01Flat = await flat(g01Ref, join(a.out, 'g01', 'ref-flat'), G01_TIMES);
  const ncFlat = await flat(ncRef, join(a.out, 'nc-onupdate', 'ref-flat'), G01_TIMES);
  const g01FlatNext = await flat(g01Ref, join(a.out, 'g01', 'ref-flat-plus1'), G01_TIMES, 1);

  log('comparing');
  const sets: SetReport[] = [
    await compareSet('G-01', 'compliant composition · HyperFrames snapshot vs HyperFrames PNG render', 'pass', g01Preview.files, g01Flat),
    await compareSet('NC-1', "spike's onUpdate-only counter · hand-rolled tl.seek(t) preview vs HyperFrames render", 'fail', ncHand, ncFlat),
    await compareSet('NC-2', 'compliant composition, vendored fonts blocked · hand-rolled preview vs HyperFrames render', 'fail', g01NoFonts, g01Flat),
    await compareSet('NC-3', 'one-character caption change ("Step 3" chip at 3.0 s) · HyperFrames snapshot vs the genuine HyperFrames render', 'fail', chipPreview.files, g01Flat),
    await compareSet('I-1', "spike's onUpdate-only counter · HyperFrames snapshot vs HyperFrames render", 'info', ncPreview.files, ncFlat),
    await compareSet('I-2', 'compliant composition · hand-rolled tl.seek(t) preview (fonts loaded) vs HyperFrames render', 'info', g01Hand, g01Flat),
    await compareSet('I-3', 'sensitivity · HyperFrames snapshot at t vs the render frame one step later (t + 1/30 s)', 'info', g01Preview.files, g01FlatNext),
  ];

  const g01Pass = sets[0]?.pass === true;
  const controlsCaught = sets[1]?.pass === false && sets[2]?.pass === false && sets[3]?.pass === false;
  const verdict = g01Pass && controlsCaught ? 'PASS' : 'FAIL';

  const hfVersion = (await run(process.execPath, [a.hf, '--version'], env)).stdout.trim();
  const ffVersion = (await run('ffmpeg', ['-version'], env)).stdout.split(/\r?\n/)[0] ?? '';
  const gpuLine = g01Preview.log.split(/\r?\n/).find((l) => l.includes('browserGpuMode')) ?? '';
  const renderSummary = g01Ref.log.split(/\r?\n/).filter((l) => /rendered in|capture ·|screenshot capture/.test(l)).join(' / ');

  const files: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d)) {
      const p = join(d, e);
      if ((await stat(p)).isDirectory()) {
        if (e === 'work' || e === 'ref' || e === '.hyperframes') continue;
        await walk(p);
      } else if (p.endsWith('.png')) files.push(p);
    }
  };
  await walk(a.out);
  const sums = await Promise.all(files.sort().map(async (f) => `${await sha256(f)}  ${relative(a.out, f).replaceAll('\\', '/')}`));
  await writeFile(join(a.out, 'SHA256SUMS'), `${sums.join('\n')}\n`, 'utf8');

  const report = {
    verdict,
    g01Pass,
    controlsCaught,
    thresholds: G01_THRESHOLDS,
    regions: G01_REGIONS,
    versions: { hyperframes: hfVersion, ffmpeg: ffVersion, node: process.version, browser: a.browser ?? null, gpu: gpuLine.trim() },
    timings: {
      g01SnapshotMs: Math.round(g01Preview.ms),
      g01RenderPngMs: Math.round(g01Ref.ms),
      ncSnapshotMs: Math.round(ncPreview.ms),
      ncRenderPngMs: Math.round(ncRef.ms),
      g01RenderSummary: renderSummary.trim(),
    },
    referenceBackground: g01Ref.background,
    sets,
  };
  await writeFile(join(a.out, 'results.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const md = [
    `# G-01 run — ${verdict}`,
    '',
    `G-01 set ${g01Pass ? 'passes' : 'fails'}; negative controls ${controlsCaught ? 'all three fail (caught)' : 'NOT all caught'}.`,
    `Bar: frame PSNR ≥ ${G01_THRESHOLDS.framePsnrDb} dB, and in every text region ink IoU ≥ ${G01_THRESHOLDS.inkIoU} and max |Δ luma| ≤ ${G01_THRESHOLDS.regionMaxDelta}, every pair.`,
    '',
    ...sets.map((s) => table(s, a.out)),
  ].join('\n');
  await writeFile(join(a.out, 'results.md'), md, 'utf8');
  console.log(md);
  process.exit(verdict === 'PASS' ? 0 : 1);
}

await main();
