// akuko doctor, runtime packages. Plain JavaScript on purpose: it runs BEFORE any
// TypeScript action, so it must not import zod or @ikenga/studio-schema itself.
//
//   node scripts/doctor/deps.mjs
//
// An installed skill (copied, or `npx skills add`) has no node_modules, so every
// TypeScript action and scripts/check-view.mjs would crash with "Cannot find
// package ...". This names what is missing and prints the exact install command.
// Exit 0: all required packages resolve. Exit 1: a required one is missing.
// Packaging them properly (bundling, or real runtime dependencies) is WP-20 (the v0.x release).
//
// Test hook (never set in real use): AKUKO_DOCTOR_HIDE_PKGS="zod,ajv" treats those as not installed.

const PACKAGES = [
  { name: 'zod', range: '^3.23.0', needed: 'every action (the akuko.json schema)', required: true },
  { name: '@ikenga/studio-schema', range: '^0.2.0', needed: 'every action (shared studio types)', required: true },
  { name: 'ajv', range: '^8.20.0', needed: 'scripts/check-view.mjs (checking a hand-written board)', required: false },
  { name: 'ajv-formats', range: '^3.0.1', needed: 'scripts/check-view.mjs', required: false },
  { name: 'jsdom', range: '29.1.1', needed: 'scripts/check-view.mjs', required: false },
];

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
  console.log('fix: with the person\'s OK, run this in the skill folder (nothing else is changed):');
  console.log(`  npm install --no-save ${missing.map((p) => `${p.name}@${JSON.stringify(p.range).slice(1, -1)}`).join(' ')}`);
  console.log('note: this is a stop-gap for an installed skill. Bundling these packages with the skill is planned for the v0.x release (WP-20).');
}
process.exit(missing.some((p) => p.required) ? 1 : 0);
