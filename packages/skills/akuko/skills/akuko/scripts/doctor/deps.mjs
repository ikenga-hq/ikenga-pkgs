// akuko doctor, runtime packages. Plain JavaScript on purpose: it runs BEFORE any
// TypeScript action, so it must not import zod or @ikenga/studio-schema itself.
//
//   node scripts/doctor/deps.mjs
//
// An installed skill (copied, or `npx skills add`) has no node_modules until someone
// runs `npm install` in it, so every TypeScript action and scripts/check-view.mjs would
// crash with "Cannot find package ...". This names what is missing and prints the exact
// install command. Exit 0: all required packages resolve. Exit 1: a required one is missing.
// The published skill (ikenga-hq/akuko, built by ../../../../scripts/build-mirror.mjs) ships
// a package.json with pinned versions and a vendored @ikenga/studio-schema, so there the
// fix is a plain `npm install` in the skill folder.
//
// Test hook (never set in real use): AKUKO_DOCTOR_HIDE_PKGS="zod,ajv" treats those as not installed.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGES = [
  { name: 'zod', range: '^3.23.0', needed: 'every action (the akuko.json schema)', required: true },
  { name: '@ikenga/studio-schema', range: '^0.2.0', needed: 'every action (shared studio types)', required: true },
  { name: 'ajv', range: '^8.20.0', needed: 'scripts/check-view.mjs (checking a hand-written board)', required: false },
  { name: 'ajv-formats', range: '^3.0.1', needed: 'scripts/check-view.mjs', required: false },
  { name: 'jsdom', range: '29.1.1', needed: 'scripts/check-view.mjs', required: false },
];

// --prefix pins npm to the skill folder, so it never walks up to a stray package.json.
const SKILL_DIR = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');
const hidden = new Set((process.env.AKUKO_DOCTOR_HIDE_PKGS ?? '').split(',').map((s) => s.trim()).filter(Boolean));

function resolves(name) {
  if (hidden.has(name)) return false;
  try {
    import.meta.resolve(name); // resolved from this file's folder, i.e. the skill folder, like the actions do
    return true;
  } catch {
    return false;
  }
}

const missing = PACKAGES.filter((p) => !resolves(p.name));
console.log('runtime packages (resolved from the skill folder, nothing imported):');
for (const p of PACKAGES) {
  const ok = !missing.includes(p);
  console.log(`  ${p.name.padEnd(24)} ${ok ? 'ok' : p.required ? 'MISSING (required)' : 'MISSING (optional)'}${ok ? '' : `  needed by ${p.needed}`}`);
}

if (missing.length > 0) {
  console.log("fix: with the person's OK, run this for the skill folder (nothing else is changed):");
  if (existsSync(join(SKILL_DIR, 'package.json'))) {
    // The published skill: its package.json pins every package (and vendors @ikenga/studio-schema).
    console.log(`  npm install --no-audit --no-fund --prefix "${SKILL_DIR}"`);
  } else {
    console.log(`  npm install --no-save --prefix "${SKILL_DIR}" ${missing.map((p) => `${p.name}@${JSON.stringify(p.range).slice(1, -1)}`).join(' ')}`);
    console.log('note: this copy has no package.json. The published skill (ikenga-hq/akuko) ships one; there, run `npm install` in the skill folder instead.');
  }
}
process.exit(missing.some((p) => p.required) ? 1 : 0);
