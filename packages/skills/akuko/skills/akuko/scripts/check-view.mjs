#!/usr/bin/env node
// akuko — view conformance check (gate G-VIEW). Contract: views/contract.md.
//
//   node scripts/check-view.mjs <view.html>… [--project <akuko.json>] [--json] [--record <conformed.json>]
//
// Loads each view with the fixture project (default: the converted "The
// Beating", fixtures/the-beating/akuko.json), then with a changed copy of it,
// and checks: the manifest, every required view and field, the money and the
// "your move" counts against the data, every data-akuko-action control (one
// person's click → exactly one valid Decision, in each host's store), and the
// five renderer rules as far as a machine can. Exit code 0 only if every file
// passes. With --record, each passing file is added to a conformed-views list
// ({view, sha256, checked_at, checker}); folding accepts approvals only from
// views on that list (decisions/conformed.ts).
//
// Needs the package's dev dependencies (jsdom, ajv, ajv-formats). The page's
// scripts run inside jsdom: only check views you would open anyway.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHECKER, checkView } from './check-view/check.mjs';

function parse(argv) {
  const files = [];
  const o = { json: false, project: undefined, record: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--project') o.project = argv[++i];
    else if (a === '--record') o.record = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else files.push(a);
  }
  return { files, ...o };
}

function record(path, results) {
  const list = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { format: 'akuko-conformed-views', version: 1, views: [] };
  if (list.format !== 'akuko-conformed-views' || !Array.isArray(list.views)) throw new Error(`${path} is not a conformed-views file`);
  const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const refused = [];
  for (const r of results) {
    if (!r.ok || !r.view) continue;
    const had = list.views.find((v) => v.view === r.view);
    if (had && had.sha256 && had.sha256 !== r.sha256) {
      // One id@version is one exact page: a changed page needs a new version.
      refused.push(`${r.file}: ${r.view} is already recorded for different HTML (sha256 ${had.sha256.slice(0, 12)}…); bump "version" in its akuko-view manifest and check it again`);
      continue;
    }
    list.views = list.views.filter((v) => v.view !== r.view);
    list.views.push({ view: r.view, sha256: r.sha256, checked_at: at, checker: CHECKER });
  }
  writeFileSync(path, `${JSON.stringify(list, null, 2)}\n`);
  return refused;
}

export async function main(argv) {
  const args = parse(argv);
  if (args.files.length === 0) {
    console.error('usage: node scripts/check-view.mjs <view.html>… [--project <akuko.json>] [--json] [--record <conformed.json>]');
    return 2;
  }
  const project = args.project ? JSON.parse(readFileSync(args.project, 'utf8')) : undefined;
  const results = [];
  for (const file of args.files) {
    const r = await checkView(readFileSync(file, 'utf8'), { project });
    results.push({ file, ...r });
    if (!args.json) {
      console.log(`${r.ok ? 'PASS' : 'FAIL'} ${file}${r.view ? ` (${r.view})` : ''} · ${r.decisions_checked} decisions checked`);
      for (const f of r.failures) console.log(`  ${f.rule} ${f.code}: ${f.message}`);
    }
  }
  const refused = args.record ? record(args.record, results) : [];
  for (const m of refused) console.error(`NOT RECORDED ${m}`);
  if (args.json) console.log(JSON.stringify(results, null, 2));
  return results.every((r) => r.ok) && refused.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 2; });
}
