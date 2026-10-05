#!/usr/bin/env node
/**
 * build-mirror.mjs — emit the standalone `ikenga-hq/groundwork` mirror tree.
 *
 * The mirror repo is the `npx skills add ikenga-hq/groundwork` install
 * surface. It mirrors the proven `ikenga-artifact-builder` layout:
 *
 *   <out>/
 *   ├── package.json   (mirror — slimmed from this package's)
 *   ├── README.md      (install + portability pointer)
 *   ├── install.sh     (clone + symlink; SKILL_NAME=groundwork)
 *   ├── LICENSE         (Apache-2.0)
 *   ├── .gitignore
 *   └── skills/groundwork/   (copied from this package's synced tree)
 *
 * This script does NOT push anywhere. It only produces the tree locally so a
 * (gated) follow-up can review + push it to ikenga-hq/groundwork.
 *
 * ./skills/groundwork/ is the source tree (no sync step since 2026-08-21).
 *
 * --- Version-parity guard ---------------------------------------------
 * This package's version is only trustworthy for the mirror once the
 * Changesets release job has actually bumped it on ikenga-pkgs main. A
 * human building the mirror from a checkout taken between "content PR
 * merged" and "chore: version packages landed" will silently emit a
 * mirror labelled with the PRE-bump version (see 2026-07-17: PR #41 merged
 * with new content while package.json still read 0.4.0; mirror PR #3 was
 * built + pushed 32s later from that same pre-bump tree; the version-bump
 * commit landed 31s after THAT — the mirror shipped "0.4.0" carrying
 * 0.5.0-worthy content). Two checks guard against repeating this:
 *
 *   1. (hermetic) Any pending .changeset/*.md entry that still targets
 *      this package means main has unreleased content for it — the local
 *      version is pre-bump by definition. Hard-fail.
 *   2. (best-effort, network) Compare local version against the HIGHEST
 *      version published to npm — max(versions), not the `latest`
 *      dist-tag, which can point below it after a rewind. If npm's is
 *      newer, the local checkout is stale — hard-fail. If the registry is
 *      unreachable, warn and continue (don't make a hermetic script
 *      hard-depend on the network).
 *
 * Output excludes local build residue (__pycache__/*.pyc, node_modules,
 * .pytest_cache) so running the skill's Python helpers can't leak bytecode
 * into the published install surface.
 *
 * Pass --allow-version-drift to bypass both and build anyway.
 *
 * --- Test gate (WP-03a) -------------------------------------------------
 * The mirror is the public install surface, so it is only built from a tree
 * whose deterministic tests pass: `pnpm test` in this package
 * (test_groundwork_state.py + test_fence_integrity.py — fence-only writes and
 * idempotent re-runs). The same suite runs in ikenga-pkgs CI. A failing (or
 * unrunnable — no python3) suite aborts the build before anything is emitted.
 * There is deliberately no skip flag.
 *
 * Usage:
 *   node ./scripts/build-mirror.mjs [--out <dir>] [--allow-version-drift]
 *   (--out default: ./dist-mirror)
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync, existsSync, cpSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(PKG_ROOT, '../../..');
const SKILL_NAME = 'groundwork';
const MIRROR_REPO = 'ikenga-hq/groundwork';

const outIdx = process.argv.indexOf('--out');
const OUT = outIdx !== -1 ? resolve(process.argv[outIdx + 1]) : join(PKG_ROOT, 'dist-mirror');
const ALLOW_DRIFT = process.argv.includes('--allow-version-drift');

const SYNCED = join(PKG_ROOT, 'skills', SKILL_NAME);

async function main() {
  if (!existsSync(join(SYNCED, 'SKILL.md'))) {
    console.error(`[mirror] skill source tree not found at ${SYNCED}`);
    console.error(`[mirror] ./skills/groundwork/ is the source — it should not be missing.`);
    process.exit(1);
  }

  const src = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
  runTestGate(src);
  if (!ALLOW_DRIFT) {
    await checkVersionParity(src);
  } else {
    console.warn('[mirror] --allow-version-drift passed — skipping version-parity guard.');
  }

  // Clean rebuild of the output dir.
  if (existsSync(OUT)) rmSync(OUT, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  // 1. skills/<name>/ — copied from the synced tree.
  // Local build residue must not reach the mirror. The skill ships Python
  // helpers, so running any of them leaves `__pycache__/*.pyc` next to the
  // sources — machine- and interpreter-specific bytecode that would be
  // published to the install surface. (Observed 2026-08-24: four
  // `cpython-312.pyc` files under scripts/.) Filter on copy rather than
  // cleaning up afterwards, so the output is correct regardless of what the
  // working tree happens to contain.
  const MIRROR_EXCLUDE = new Set(['__pycache__', 'node_modules', '.pytest_cache', '.DS_Store']);
  cpSync(SYNCED, join(OUT, 'skills', SKILL_NAME), {
    recursive: true,
    filter: (srcPath) => {
      const base = basename(srcPath);
      if (MIRROR_EXCLUDE.has(base)) return false;
      if (base.endsWith('.pyc') || base.endsWith('.pyo')) return false;
      return true;
    },
  });

  // 2. LICENSE — copied verbatim.
  cpSync(join(PKG_ROOT, 'LICENSE'), join(OUT, 'LICENSE'));

  // 3. package.json — slimmed mirror (standalone repo, not a workspace member).
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

  // 4. install.sh — adapted from ikenga-artifact-builder, SKILL_NAME=groundwork.
  writeFileSync(join(OUT, 'install.sh'), INSTALL_SH, { mode: 0o755 });

  // 5. README.md — install + portability pointer.
  writeFileSync(join(OUT, 'README.md'), README_MD);

  // 6. .gitignore.
  writeFileSync(join(OUT, '.gitignore'), '.DS_Store\n*.log\nnode_modules/\n');

  const fileCount = listFiles(OUT).length;
  console.log(`[mirror] emitted ${fileCount} files → ${OUT}`);
  console.log(`[mirror] next: review, then push to ${MIRROR_REPO} (gated on user approval).`);
}

// The mirror publish depends on the deterministic suite (WP-03a). Runs the
// package's own `test` script so CI and the mirror gate can never diverge.
function runTestGate(src) {
  const cmd = src.scripts?.test;
  if (!cmd) {
    console.error('[mirror] refusing to build: package.json has no `test` script (the mirror test gate).');
    process.exit(1);
  }
  console.log('[mirror] test gate: running `' + cmd + '`');
  const res = spawnSync(cmd, { cwd: PKG_ROOT, shell: true, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  const tail = (res.stdout || '').trim().split('\n').filter((l) => /passed, \d+ failed|FAIL/.test(l));
  for (const l of tail) console.log('[mirror]   ' + l.trim());
  if (res.status !== 0) {
    console.error(`[mirror] refusing to build: the groundwork test suite failed (exit ${res.status ?? res.signal}).`);
    console.error('[mirror] run `pnpm --filter @ikenga/skill-groundwork test` for the full output.');
    process.exit(1);
  }
}

// Guards against the publish-order race: building the mirror from a
// checkout taken before the Changesets release commit bumped this
// package's version. See the header comment for the incident this
// reproduces.
async function checkVersionParity(src) {
  // 1. Hermetic check: any pending changeset still targeting this package
  //    means the version bump for current content hasn't happened yet.
  const changesetDir = join(REPO_ROOT, '.changeset');
  if (existsSync(changesetDir)) {
    const pending = readdirSync(changesetDir).filter(
      (f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md'
    );
    const targeting = pending.filter((f) => {
      const body = readFileSync(join(changesetDir, f), 'utf8');
      return body.includes(`"${src.name}"`);
    });
    if (targeting.length > 0) {
      console.error(
        `[mirror] refusing to build: ${targeting.length} pending changeset(s) still target ${src.name}:`
      );
      for (const f of targeting) console.error(`[mirror]   - .changeset/${f}`);
      console.error(
        `[mirror] this means main has unreleased content for this package — package.json (${src.version}) is pre-bump.`
      );
      console.error(
        '[mirror] wait for the Changesets release job ("chore: version packages") to land, `git pull`, then retry.'
      );
      console.error('[mirror] or pass --allow-version-drift to build anyway.');
      process.exit(1);
    }
  }

  // 2. Best-effort network check: local version vs. the HIGHEST version
  //    published to npm.
  //
  //    This deliberately reads the full packument rather than `/latest`.
  //    `/latest` resolves the dist-tag, which is not the same thing as the
  //    newest version and can point *below* it. groundwork is the live
  //    example: an accidental 0.7.0 -> 0.8.0 -> 0.9.0 run on 2026-08-23 was
  //    rewound by `b8b15ac chore(groundwork): reset version line to 0.7.2`,
  //    so npm holds 0.8.0 and 0.9.0 while `latest` is 0.7.6. Asking for
  //    `/latest` returned 0.7.6, matched the local version exactly, and the
  //    guard passed — blind to two higher published versions. Comparing
  //    against max(versions) is what this check was always meant to do.
  //
  //    Warn (don't block) if the registry is unreachable — this script is
  //    otherwise hermetic and shouldn't hard-depend on network access.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(src.name)}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      console.warn(`[mirror] npm registry lookup for ${src.name} returned ${res.status} — skipping this check.`);
      return;
    }
    const packument = await res.json();
    const all = Object.keys(packument.versions || {});
    if (all.length === 0) {
      console.warn(`[mirror] npm returned no versions for ${src.name} — skipping this check.`);
      return;
    }
    const published = all.reduce((hi, v) => (isNewer(v, hi) ? v : hi), all[0]);
    if (published !== src.version && isNewer(published, src.version)) {
      const distTag = packument['dist-tags']?.latest;
      console.error(
        `[mirror] refusing to build: local version ${src.version} is behind the highest published npm version ${published}.`
      );
      if (distTag && distTag !== published) {
        console.error(
          `[mirror] note: npm's \`latest\` dist-tag is ${distTag}, BELOW ${published} — the version line was likely rewound.`
        );
        console.error(
          '[mirror] a rewound line means those higher versions are burned: publishing over them fails with E403.'
        );
      }
      console.error('[mirror] this checkout is stale — `git pull` on ikenga-pkgs main and retry.');
      console.error('[mirror] or pass --allow-version-drift to build anyway.');
      process.exit(1);
    }
  } catch (err) {
    console.warn(`[mirror] could not reach npm registry to verify version parity (${err.message}) — continuing.`);
  }
}

function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da > db;
  }
  return false;
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(full);
  }
  return out;
}

const INSTALL_SH = `#!/usr/bin/env bash
#
# groundwork — install script
#
# Installs the skill into ~/.claude/skills/groundwork as a symlink against a
# cached clone in ~/.cache/ikenga-skills/. Update path is
# \`git -C ~/.cache/ikenga-skills/groundwork pull\`.
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/ikenga-hq/groundwork/main/install.sh | bash
#
# Env overrides:
#   SKILLS_DIR    target skills dir (default: $HOME/.claude/skills)
#   CACHE_DIR     clone cache dir   (default: $HOME/.cache/ikenga-skills)
#   REPO_URL      repo to clone     (default: https://github.com/ikenga-hq/groundwork.git)
#   REF           git ref to check out (default: main)

set -euo pipefail

SKILL_NAME="groundwork"
SKILLS_DIR="\${SKILLS_DIR:-$HOME/.claude/skills}"
CACHE_DIR="\${CACHE_DIR:-$HOME/.cache/ikenga-skills}"
REPO_URL="\${REPO_URL:-https://github.com/ikenga-hq/groundwork.git}"
REF="\${REF:-main}"

CLONE_DIR="$CACHE_DIR/$SKILL_NAME"
TARGET="$SKILLS_DIR/$SKILL_NAME"
SOURCE="$CLONE_DIR/skills/$SKILL_NAME"

log()  { printf '\\033[36m[ikenga]\\033[0m %s\\n' "$*"; }
warn() { printf '\\033[33m[ikenga]\\033[0m %s\\n' "$*" >&2; }
die()  { printf '\\033[31m[ikenga]\\033[0m %s\\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required but not installed."

mkdir -p "$SKILLS_DIR" "$CACHE_DIR"

if [ -d "$CLONE_DIR/.git" ]; then
  log "Updating cached clone at $CLONE_DIR"
  git -C "$CLONE_DIR" fetch --quiet origin "$REF"
  git -C "$CLONE_DIR" checkout --quiet "$REF"
  git -C "$CLONE_DIR" reset --quiet --hard "origin/$REF"
else
  log "Cloning $REPO_URL into $CLONE_DIR"
  git clone --quiet --branch "$REF" --depth 1 "$REPO_URL" "$CLONE_DIR"
fi

[ -d "$SOURCE" ] || die "Skill source not found at $SOURCE (repo layout changed?)."

if [ -L "$TARGET" ]; then
  log "Replacing existing symlink at $TARGET"
  rm "$TARGET"
elif [ -e "$TARGET" ]; then
  BACKUP="$TARGET.bak.\$(date +%s)"
  warn "Existing non-symlink at $TARGET — backing up to $BACKUP"
  mv "$TARGET" "$BACKUP"
fi

ln -s "$SOURCE" "$TARGET"

log "Installed: $TARGET -> $SOURCE"
log "Update later: git -C $CLONE_DIR pull"
`;

const README_MD = `# groundwork

A Claude Code skill that scaffolds and maintains a reusable
**research → design → plan → orchestrate → act** folder for any non-trivial
work — software features, marketing campaigns, org changes.

It drops a domain-agnostic spine (\`00-README\` · \`01-plan\` · \`02/03\` research ·
\`04-discussion\` newest-first · \`05-tracking\` · \`09-orchestration\`) plus
stateless action-skills that augment the docs in place without clobbering
hand-written prose. The defining property: **re-runs augment your work, they
never overwrite it** — a checksum decides what changes on disk, not the model.
Profile-driven: \`software\` (rich default), \`general\` (lean, non-code),
\`content\` (editorial + key art), and \`design-system\` (component/token libraries).

Each plan also gets self-contained **HTML views** that open in any browser and
light up live inside the Ikenga shell:

- **Board** (\`artifact/board.html\`) — Mission-Control, Kanban, and dependency-graph views of the plan's execution state.
- **Explorer** (\`artifact/explorer.html\`) — a file tree + tabbed viewer with full-text search; **fully offline** (libs inlined, runs air-gapped / in Claude Desktop).
- **Plans index** (\`<plans-dir>/_index.html\`) — a cross-plan dashboard, one card per plan.

> **This repo is a generated mirror.** The canonical source lives in
> \`ikenga-hq/ikenga-pkgs\` at \`packages/skills/groundwork/\` (ADR-009), itself
> synced from the workspace dev copy. Do not edit files here — they are
> overwritten by the mirror build.

## Install

### \`npx skills\` (recommended)

The [\`skills\`](https://skills.sh) CLI works with Claude Code, Codex, Cursor,
OpenCode, and 50+ other agents.

\`\`\`bash
# Global install (recommended — available across all projects)
npx skills add ikenga-hq/groundwork -g

# Project install (committed with your repo, shared with team)
npx skills add ikenga-hq/groundwork
\`\`\`

### Git clone

\`\`\`bash
git clone https://github.com/ikenga-hq/groundwork.git
cp -r groundwork/skills/groundwork ~/.claude/skills/
\`\`\`

### Curl one-liner

\`\`\`bash
curl -sSL https://raw.githubusercontent.com/ikenga-hq/groundwork/main/install.sh | bash
\`\`\`

The installer drops the skill into \`~/.claude/skills/groundwork/\` via symlink
against a cached clone in \`~/.cache/ikenga-skills/\`, so \`git pull\` is the
update path.

## Usage

After install, in any Claude Code session:

\`\`\`
/groundwork init plans/<your-plan>/ --profile software --goal "…"
\`\`\`

then \`research\` / \`design\` / \`review\` / \`orchestrate\` / \`refresh-board\` /
\`explorer\` / \`plans-index\` as the work progresses. See
[\`skills/groundwork/SKILL.md\`](skills/groundwork/SKILL.md) for the full
agent-facing spec and [\`skills/groundwork/README.md\`](skills/groundwork/README.md)
for an overview.

## Portability

A few references in the docs and the standalone board point at this-workspace
example paths (\`plans/studio\` / \`plans/groundwork\`). They are illustrative; see
[\`skills/groundwork/PORTABILITY.md\`](skills/groundwork/PORTABILITY.md).

## License

[Apache-2.0](LICENSE). Copyright © 2026 Royalti.io.
`;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
