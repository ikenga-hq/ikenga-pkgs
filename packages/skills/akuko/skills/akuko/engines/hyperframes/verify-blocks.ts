// Run HyperFrames `lint` and `check` on every block (each mounted alone) and on the showcase.
// Needs Chrome + HyperFrames, so CI never runs it (not a *.test.ts). Outputs go under --out.
//
//   node --experimental-strip-types engines/hyperframes/verify-blocks.ts \
//     --hf <path to hyperframes.mjs> --out <scratch dir> [--only stat,ken-burns] [--snapshot]
//   (Windows: HYPERFRAMES_BROWSER_PATH must point at Chrome.)

import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCKS, hostHtml, type BlockId } from './blocks.ts';
import { check, lint, snapshot, type CheckResult, type EngineOptions, type FindingSet, type LintResult } from './cli.ts';

const here = dirname(fileURLToPath(import.meta.url));
const blocksDir = resolve(here, '..', '..', 'blocks');

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function stageFonts(dir: string): Promise<void> {
  await mkdir(join(dir, 'fonts'), { recursive: true });
  for (const f of await readdir(join(blocksDir, 'fonts'))) {
    if (f.endsWith('.woff2')) await copyFile(join(blocksDir, 'fonts', f), join(dir, 'fonts', f));
  }
}

async function stageBlock(out: string, block: BlockId): Promise<string> {
  const dir = join(out, block);
  await rm(dir, { recursive: true, force: true });
  await stageFonts(dir);
  await copyFile(join(blocksDir, `${block}.html`), join(dir, `${block}.html`));
  await writeFile(join(dir, 'index.html'), hostHtml(block), 'utf8');
  return dir;
}

async function stageShowcase(out: string): Promise<string> {
  const dir = join(out, '_showcase');
  await rm(dir, { recursive: true, force: true });
  await stageFonts(dir);
  await copyFile(join(blocksDir, 'index.html'), join(dir, 'index.html'));
  for (const b of BLOCKS) await copyFile(join(blocksDir, `${b}.html`), join(dir, `${b}.html`));
  return dir;
}

function counts(s: FindingSet | undefined): string {
  if (!s) return '—';
  return `${s.ok ? 'ok' : 'FAIL'} ${s.errorCount}e/${s.warningCount}w/${s.infoCount}i`;
}

function findingLines(name: string, sets: Record<string, FindingSet>): string[] {
  const lines: string[] = [];
  for (const [section, s] of Object.entries(sets)) {
    for (const f of s.findings) lines.push(`- ${name} · ${section} · ${f.severity} \`${f.code}\` ${f.selector ?? ''} — ${f.message.replace(/\s+/g, ' ').slice(0, 220)}`);
  }
  return lines;
}

async function main(): Promise<void> {
  const hf = arg('--hf') ?? process.env.HYPERFRAMES_BIN;
  const outArg = arg('--out');
  if (!hf || !outArg) {
    console.error('usage: verify-blocks.ts --hf <hyperframes.mjs> --out <dir> [--only a,b] [--snapshot]');
    process.exit(2);
  }
  const out = resolve(outArg);
  const only = arg('--only')?.split(',') as BlockId[] | undefined;
  const opts: EngineOptions = { bin: resolve(hf) };
  const rows: string[] = ['| block | lint | check | runtime | layout | contrast | craft | motion |', '|---|---|---|---|---|---|---|---|'];
  const details: string[] = [];
  const results: Record<string, { lint: LintResult; check: CheckResult }> = {};
  let allOk = true;

  const targets: (BlockId | '_showcase')[] = only ?? [...BLOCKS, '_showcase'];
  for (const name of targets) {
    console.log(`[blocks] ${name}`);
    const dir = name === '_showcase' ? await stageShowcase(out) : await stageBlock(out, name);
    const l = await lint(dir, opts);
    const c = await check(dir, opts);
    if (process.argv.includes('--snapshot') && name !== '_showcase') {
      await snapshot(dir, { frames: 4, outDir: join(out, `${name}-snap`) }, opts);
    }
    results[name] = { lint: l, check: c };
    const s = c.sections;
    rows.push(`| ${name} | ${counts(l)} | ${c.ok ? 'ok' : 'FAIL'} | ${counts(s.runtime)} | ${counts(s.layout)} | ${counts(s.contrast)} | ${counts(s.craft)} | ${counts(s.motion)} |`);
    details.push(...findingLines(name, { lint: l, ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'lint')) }));
    if (!l.ok || !c.ok) allOk = false;
  }
  const md = ['# Block verification', '', ...rows, '', '## Findings', '', ...(details.length ? details : ['none']), ''].join('\n');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'blocks-verify.md'), md, 'utf8');
  await writeFile(join(out, 'blocks-verify.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  console.log(md);
  process.exit(allOk ? 0 : 1);
}

await main();
