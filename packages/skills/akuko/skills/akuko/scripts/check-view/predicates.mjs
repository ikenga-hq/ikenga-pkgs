// Does a view write decisions? One predicate for check-view (which views may
// be skipped as read-only) and every host's publishView gate (which views need
// a conformance record), so the two can never disagree (07a2 review B8).
// Plain JS so check-view runs without a TypeScript step; hosts/shared.ts
// re-exports it. HTML comments never count.

import { blankComments, findJsonBlock } from './hash.mjs';

const Q = '["\'`]';
/** Each way a page writes decisions, as a static sign in its markup or scripts. Reads (`collection("decisions").get()`) are not writes. */
const WRITE_SIGNS = [
  [/data-akuko-action|akukoAction/i, 'a decision control (data-akuko-action)'],
  [/akuko-decision-writer|akukoDecisions/, 'the decision writer (akukoDecisions)'],
  [/akuko-outbox/, 'the decision outbox (akuko-outbox:<slug>)'],
  [/akuko\.decisions/, 'the Ikenga decisions key (akuko.decisions)'],
  [/__iyke[\s\S]{0,200}?["'`]state["'`]/, 'an Ikenga bridge state post (__iyke, kind "state")'],
  [new RegExp(`collection\\(\\s*${Q}decisions${Q}\\s*\\)\\s*\\.\\s*(?:add\\s*\\(|doc\\s*\\([^()]*\\)\\s*\\.\\s*(?:set|update|delete)\\s*\\()`), 'a write to the decisions collection'],
  [new RegExp(`\\.doc\\(\\s*${Q}decisions/[^()]*\\)\\s*\\.\\s*(?:set|update|delete)\\s*\\(`), 'a write to a decisions/<id> document'],
];

/** The akuko-view manifest, found as the hash finds data blocks (one real block; comments ignored), or undefined. */
export function viewManifest(html) {
  const b = findJsonBlock(html, 'akuko-view');
  if (b.status !== 'ok') return undefined;
  try {
    const m = JSON.parse(String(html).slice(b.start, b.end));
    return m && typeof m === 'object' ? m : undefined;
  } catch {
    return undefined;
  }
}

/** The `<id>@<version>` a view's manifest declares (what its decisions carry as `view`), or undefined. */
export function viewIdOf(html) {
  const m = viewManifest(html);
  return m && typeof m.id === 'string' && typeof m.version === 'string' ? `${m.id}@${m.version}` : undefined;
}

/** Why this page counts as writing decisions (empty: read-only). */
export function decisionWriteSigns(html) {
  const live = blankComments(html);
  const out = WRITE_SIGNS.filter(([re]) => re.test(live)).map(([, what]) => what);
  if (viewManifest(html)?.writes_decisions === true) out.push('a manifest saying writes_decisions: true');
  return out;
}
