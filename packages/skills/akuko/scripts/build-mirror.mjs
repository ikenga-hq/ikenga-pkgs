#!/usr/bin/env node
/**
 * build-mirror.mjs — emit the standalone `ikenga-hq/akuko` mirror tree, or the
 * claude.ai upload zip. Modelled on packages/skills/groundwork/scripts/build-mirror.mjs.
 *
 *   node ./scripts/build-mirror.mjs              [--out <dir>] [--allow-version-drift]
 *   node ./scripts/build-mirror.mjs --claudeai   [--out <dir>] [--allow-version-drift]
 *
 * Mirror (default, --out default ./dist-mirror) — the `npx skills add ikenga-hq/akuko`
 * install surface, same layout as ikenga-hq/groundwork:
 *
 *   <out>/
 *   ├── package.json    (slimmed, private: the repo is not an npm package)
 *   ├── README.md       (this package's README.md, with a "generated mirror" banner)
 *   ├── install.sh      (clone + symlink + `npm install` in the skill folder)
 *   ├── LICENSE         (Apache-2.0)
 *   ├── .gitignore
 *   └── skills/akuko/   (copied from ./skills/akuko/, plus the runtime files below)
 *
 * claude.ai (--claudeai, --out default ./dist-claudeai) — `akuko.zip` holding one
 * top-level `akuko/` folder with only the files the skill needs at run time.
 * claude.ai rejects a skill zip with more than 200 files; the build fails if the
 * count goes over. Excluded: tests, `__fixtures__/`, `fixtures/`, `evals/`, and
 * `blocks/` (HyperFrames compositions, which cannot render on claude.ai). Three
 * fixture files are put back because a runtime path reads them (see CLAUDEAI_KEEP).
 *
 * --- Runtime dependencies ------------------------------------------------
 * Every TypeScript action imports `zod` and `@ikenga/studio-schema`. In the
 * monorepo they come from this package's node_modules; an installed skill has
 * none. Both outputs therefore add, inside the skill folder:
 *
 *   package.json                 pinned versions (read from this package's
 *                                installed node_modules, i.e. the lockfile)
 *   vendor/studio-schema/        the built @ikenga/studio-schema (dist/schema.js
 *                                + .d.ts), referenced as a `file:` dependency.
 *                                Vendored rather than taken from npm because the
 *                                workspace source can be ahead of the last npm
 *                                release, and the tests ran against the source.
 *
 * so `npm install` in the skill folder makes it runnable (doctor prints exactly
 * that command when packages are missing). jsdom / ajv / ajv-formats are
 * optionalDependencies: only scripts/check-view.mjs needs them.
 *
 * --- Test gate -----------------------------------------------------------
 * Both outputs are public install surfaces, so they are only built from a tree
 * whose tests pass: the same files as this package's `test` script (what CI
 * runs). One exception: on Windows, scripts/check-view.test.ts is left out
 * (its headless jsdom checks hang locally on Windows; CI on Linux runs it).
 * The build says so when it happens. There is deliberately no skip flag.
 *
 * --- Version-parity guard -------------------------------------------------
 * Same as groundwork's: a pending .changeset/*.md that targets this package means
 * package.json is pre-bump, so the build refuses (and it compares with npm when
 * the package is published there). --allow-version-drift builds anyway, e.g. for
 * a review build before the release PR lands.
 *
 * This script never pushes or uploads anything.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync, existsSync, cpSync, globSync } from 'node:fs';
import { join, dirname, resolve, basename, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execSync } from 'node:child_process';
import { deflateRawSync, crc32 } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(PKG_ROOT, '../../..');
const SKILL_NAME = 'akuko';
const MIRROR_REPO = 'ikenga-hq/akuko';
const STUDIO_SCHEMA_DIR = join(REPO_ROOT, 'packages', 'apps', 'studio', 'shared');

const CLAUDEAI = process.argv.includes('--claudeai');
const ALLOW_DRIFT = process.argv.includes('--allow-version-drift');
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx !== -1 ? resolve(process.argv[outIdx + 1]) : join(PKG_ROOT, CLAUDEAI ? 'dist-claudeai' : 'dist-mirror');

const SKILL_SRC = join(PKG_ROOT, 'skills', SKILL_NAME);
const CLAUDEAI_MAX_FILES = 200;

// Local residue that must never reach a published tree.
const RESIDUE = new Set(['node_modules', '__pycache__', '.pytest_cache', '.DS_Store', 'dist-mirror', 'dist-claudeai']);

// claude.ai: dropped directories (any depth for __fixtures__, top level for the rest).
const CLAUDEAI_DROP_ANYWHERE = new Set(['__fixtures__']);
const CLAUDEAI_DROP_TOP = new Set(['fixtures', 'evals', 'blocks']);
// ...and the fixture files a runtime path reads, put back:
//  - scripts/check-view/check.mjs: DEFAULT_PROJECT is fixtures/the-beating/akuko.json
//    (check-view without --project), and reservedViews() hashes the two fixture views
//    so a page cannot borrow their ids (G-VIEW C7). actions/view.md also names
//    tiny-board.html as a starting point for a freehand view.
const CLAUDEAI_KEEP = [
  'fixtures/the-beating/akuko.json',
  'views/__fixtures__/tiny-board.html',
  'views/__fixtures__/board-b-instrumented.html',
];

// Runtime packages: [name, kind]. Versions are read from the installed tree.
const RUNTIME_DEPS = [
  ['zod', 'dependencies'],
  ['ajv', 'optionalDependencies'],
  ['ajv-formats', 'optionalDependencies'],
  ['jsdom', 'optionalDependencies'],
];

async function main() {
  if (!existsSync(join(SKILL_SRC, 'SKILL.md'))) {
    die(`skill source tree not found at ${SKILL_SRC}`);
  }
  const src = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));

  // Parity first: it is instant, the test gate takes minutes.
  if (!ALLOW_DRIFT) await checkVersionParity(src);
  else console.warn('[mirror] --allow-version-drift passed: skipping the version-parity guard.');
  runTestGate();

  const runtime = runtimeFiles(src);

  if (existsSync(OUT)) rmSync(OUT, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  if (CLAUDEAI) buildClaudeAi(runtime);
  else buildMirror(src, runtime);
}

// ─────────────────────────────────────────────────────────────────────────
// Mirror
// ─────────────────────────────────────────────────────────────────────────

function buildMirror(src, runtime) {
  const skillOut = join(OUT, 'skills', SKILL_NAME);
  cpSync(SKILL_SRC, skillOut, {
    recursive: true,
    filter: (p) => !RESIDUE.has(basename(p)) && !p.endsWith('.pyc'),
  });
  for (const [rel, content] of runtime) {
    mkdirSync(dirname(join(skillOut, rel)), { recursive: true });
    writeFileSync(join(skillOut, rel), content);
  }

  cpSync(join(SKILL_SRC, 'LICENSE'), join(OUT, 'LICENSE'));

  const mirrorPkg = {
    name: src.name,
    version: src.version,
    description: src.description,
    keywords: src.keywords,
    homepage: src.homepage,
    bugs: { url: `https://github.com/${MIRROR_REPO}/issues` },
    repository: { type: 'git', url: `git+https://github.com/${MIRROR_REPO}.git` },
    license: src.license,
    private: true,
    engines: src.engines,
    files: ['skills/'],
  };
  writeFileSync(join(OUT, 'package.json'), JSON.stringify(mirrorPkg, null, 2) + '\n');
  writeFileSync(join(OUT, 'install.sh'), readFileSync(join(PKG_ROOT, 'scripts', 'install.sh'), 'utf8'), { mode: 0o755 });
  writeFileSync(join(OUT, 'README.md'), MIRROR_BANNER + readFileSync(join(PKG_ROOT, 'README.md'), 'utf8'));
  writeFileSync(join(OUT, '.gitignore'), '.DS_Store\n*.log\nnode_modules/\n');
  writeFileSync(join(OUT, '.gitattributes'), '* text=auto eol=lf\n*.png binary\n*.jpg binary\n*.wav binary\n*.mp4 binary\n*.woff2 binary\n');

  const n = listFiles(OUT).length;
  console.log(`[mirror] emitted ${n} files → ${OUT}`);
  console.log(`[mirror] next: review, then push to ${MIRROR_REPO} (manual, needs the owner's OK; see PUBLISHING.md).`);
}

const MIRROR_BANNER = `> **This repo is a generated mirror.** The source lives in
> [\`ikenga-hq/ikenga-pkgs\`](https://github.com/ikenga-hq/ikenga-pkgs) at
> \`packages/skills/akuko/\` (ADR-009). Do not edit files here; the mirror build
> overwrites them. Issues and pull requests go to ikenga-pkgs.

`;

// ─────────────────────────────────────────────────────────────────────────
// claude.ai zip
// ─────────────────────────────────────────────────────────────────────────

function claudeAiKeeps(rel) {
  const parts = rel.split('/');
  if (parts.some((p) => RESIDUE.has(p))) return false;
  if (CLAUDEAI_KEEP.includes(rel)) return true;
  if (rel.endsWith('.test.ts')) return false;
  if (CLAUDEAI_DROP_TOP.has(parts[0])) return false;
  if (parts.slice(0, -1).some((p) => CLAUDEAI_DROP_ANYWHERE.has(p))) return false;
  return true;
}

function buildClaudeAi(runtime) {
  const entries = [];
  for (const full of listFiles(SKILL_SRC)) {
    const rel = relative(SKILL_SRC, full).split(sep).join('/');
    if (claudeAiKeeps(rel)) entries.push([rel, readFileSync(full)]);
  }
  for (const keep of CLAUDEAI_KEEP) {
    if (!entries.some(([rel]) => rel === keep)) die(`claude.ai build: ${keep} is read at run time but is missing from the source tree`);
  }
  for (const [rel, content] of runtime) entries.push([rel, Buffer.from(content)]);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  if (entries.length > CLAUDEAI_MAX_FILES) {
    console.error(`[claudeai] refusing to build: ${entries.length} files, claude.ai accepts at most ${CLAUDEAI_MAX_FILES}.`);
    const byTop = new Map();
    for (const [rel] of entries) byTop.set(rel.split('/')[0], (byTop.get(rel.split('/')[0]) ?? 0) + 1);
    for (const [top, n] of [...byTop].sort((a, b) => b[1] - a[1])) console.error(`[claudeai]   ${String(n).padStart(4)}  ${top}`);
    console.error('[claudeai] drop non-runtime files (scripts/build-mirror.mjs, CLAUDEAI_DROP_*) or merge small ones.');
    process.exit(1);
  }

  const zipPath = join(OUT, `${SKILL_NAME}.zip`);
  writeFileSync(zipPath, makeZip(entries.map(([rel, data]) => [`${SKILL_NAME}/${rel}`, data])));
  writeFileSync(join(OUT, 'files.txt'), entries.map(([rel]) => `${SKILL_NAME}/${rel}`).join('\n') + '\n');
  console.log(`[claudeai] ${entries.length} files (limit ${CLAUDEAI_MAX_FILES}) → ${zipPath}`);
  console.log('[claudeai] file list: ' + join(OUT, 'files.txt'));
  console.log('[claudeai] upload it in claude.ai (Settings → Capabilities → Skills) by hand; this script uploads nothing.');
}

/** Minimal ZIP writer (deflate, no directory entries, fixed 1980-01-01 timestamps → reproducible). */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data) >>> 0;
    const method = useDeflate ? 8 : 0;
    const DOS_TIME = 0;
    const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by: unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((0o100644 << 16) >>> 0), 38); // -rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

// ─────────────────────────────────────────────────────────────────────────
// Runtime files: skill package.json + vendored @ikenga/studio-schema
// ─────────────────────────────────────────────────────────────────────────

function installedVersion(name) {
  const p = join(PKG_ROOT, 'node_modules', name, 'package.json');
  if (!existsSync(p)) die(`${name} is not installed in ${PKG_ROOT}: run \`pnpm install --frozen-lockfile --filter "@ikenga/skill-akuko..."\` first`);
  return JSON.parse(readFileSync(p, 'utf8')).version;
}

function runtimeFiles(src) {
  // Build @ikenga/studio-schema from source so the vendored copy is what the tests ran against.
  const schemaPkg = JSON.parse(readFileSync(join(STUDIO_SCHEMA_DIR, 'package.json'), 'utf8'));
  console.log('[mirror] building @ikenga/studio-schema (vendored into the skill)');
  const tsc = join(STUDIO_SCHEMA_DIR, 'node_modules', 'typescript', 'bin', 'tsc');
  const res = existsSync(tsc)
    ? spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: STUDIO_SCHEMA_DIR, stdio: 'inherit' })
    : spawnSync('pnpm --filter @ikenga/studio-schema run build', { cwd: REPO_ROOT, shell: true, stdio: 'inherit' });
  if (res.status !== 0) die('could not build @ikenga/studio-schema');

  let js = readFileSync(join(STUDIO_SCHEMA_DIR, 'dist', 'schema.js'), 'utf8');
  js = js.replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
  let dts = readFileSync(join(STUDIO_SCHEMA_DIR, 'dist', 'schema.d.ts'), 'utf8');
  dts = dts.replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
  const relImports = [...js.matchAll(/^import .* from ['"](\.[^'"]+)['"]/gm)].map((m) => m[1]);
  if (relImports.length > 0) die(`vendoring @ikenga/studio-schema: dist/schema.js now imports ${relImports.join(', ')}; vendor those too`);

  let sha = 'unknown';
  try { sha = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }

  const vendorPkg = {
    name: schemaPkg.name,
    version: schemaPkg.version,
    description: `Vendored copy of ${schemaPkg.name} (built from ikenga-hq/ikenga-pkgs packages/apps/studio/shared at ${sha}). It imports zod, which resolves from the skill folder's node_modules, so it declares no dependencies of its own (one zod for both).`,
    license: schemaPkg.license,
    private: true,
    type: 'module',
    main: './dist/schema.js',
    types: './dist/schema.d.ts',
    exports: { '.': { types: './dist/schema.d.ts', import: './dist/schema.js' }, './package.json': './package.json' },
  };

  const deps = {};
  const optional = {};
  for (const [name, kind] of RUNTIME_DEPS) (kind === 'dependencies' ? deps : optional)[name] = installedVersion(name);
  deps[schemaPkg.name] = 'file:./vendor/studio-schema';

  const skillPkg = {
    name: 'akuko-skill',
    version: src.version,
    private: true,
    description: 'Runtime dependencies of the akuko skill. Run `npm install` in this folder once; `bash scripts/doctor.sh` checks it.',
    license: src.license,
    type: 'module',
    engines: src.engines,
    dependencies: sortKeys(deps),
    optionalDependencies: sortKeys(optional),
  };

  return [
    ['package.json', JSON.stringify(skillPkg, null, 2) + '\n'],
    ['vendor/studio-schema/package.json', JSON.stringify(vendorPkg, null, 2) + '\n'],
    ['vendor/studio-schema/dist/schema.js', js],
    ['vendor/studio-schema/dist/schema.d.ts', dts],
  ];
}

const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

// ─────────────────────────────────────────────────────────────────────────
// Test gate
// ─────────────────────────────────────────────────────────────────────────

function runTestGate() {
  let files = globSync('skills/akuko/**/*.test.ts', { cwd: PKG_ROOT, exclude: (p) => p.includes('node_modules') })
    .map((p) => p.split(sep).join('/'))
    .sort();
  if (files.length === 0) die('test gate: no test files found');
  if (process.platform === 'win32') {
    const skipped = files.filter((f) => f.endsWith('scripts/check-view.test.ts'));
    files = files.filter((f) => !skipped.includes(f));
    for (const f of skipped) console.warn(`[mirror] test gate: skipping ${f} on Windows (its headless checks hang locally; CI on Linux runs it).`);
  }
  console.log(`[mirror] test gate: node --test on ${files.length} files`);
  const res = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', '--experimental-strip-types', '--disable-warning=ExperimentalWarning', ...files],
    { cwd: PKG_ROOT, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  const summary = (res.stdout || '').split('\n').filter((l) => /^# (tests|pass|fail|cancelled|skipped|todo|duration_ms)\b/.test(l));
  for (const l of summary) console.log('[mirror]   ' + l.trim());
  if (res.status !== 0) {
    const failing = (res.stdout || '').split('\n').filter((l) => /^not ok /.test(l)).slice(0, 20);
    for (const l of failing) console.error('[mirror]   ' + l.trim());
    die(`refusing to build: the akuko test suite failed (exit ${res.status ?? res.signal}). Run \`pnpm --filter @ikenga/skill-akuko test\` for the full output.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Version parity (as groundwork)
// ─────────────────────────────────────────────────────────────────────────

async function checkVersionParity(src) {
  const changesetDir = join(REPO_ROOT, '.changeset');
  if (existsSync(changesetDir)) {
    const targeting = readdirSync(changesetDir)
      .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
      .filter((f) => readFileSync(join(changesetDir, f), 'utf8').includes(`"${src.name}"`));
    if (targeting.length > 0) {
      console.error(`[mirror] refusing to build: ${targeting.length} pending changeset(s) still target ${src.name}:`);
      for (const f of targeting.slice(0, 10)) console.error(`[mirror]   - .changeset/${f}`);
      if (targeting.length > 10) console.error(`[mirror]   … and ${targeting.length - 10} more`);
      console.error(`[mirror] main has unreleased content for this package, so package.json (${src.version}) is pre-bump.`);
      console.error('[mirror] wait for the Changesets release PR ("chore: version packages") to land, pull, then retry,');
      console.error('[mirror] or pass --allow-version-drift for a review build.');
      process.exit(1);
    }
  }
  if (src.private) return; // never on npm
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(src.name)}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      console.warn(`[mirror] npm registry lookup for ${src.name} returned ${res.status}: skipping this check.`);
      return;
    }
    const all = Object.keys((await res.json()).versions || {});
    if (all.length === 0) return;
    const published = all.reduce((hi, v) => (isNewer(v, hi) ? v : hi), all[0]);
    if (isNewer(published, src.version)) {
      die(`refusing to build: local version ${src.version} is behind the highest published npm version ${published}; pull main and retry (or --allow-version-drift).`);
    }
  } catch (err) {
    console.warn(`[mirror] could not reach the npm registry to check version parity (${err.message}): continuing.`);
  }
}

function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (RESIDUE.has(entry) || entry.endsWith('.pyc')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

function die(msg) {
  console.error(`[mirror] ${msg}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
