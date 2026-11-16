// What a conforming view must show for a given project, computed from the
// data the same way the spend gate and folding do (spend/ledger.ts,
// decisions/fold.ts). Plain JS so check-view runs without a TypeScript step;
// scripts/check-view.test.ts checks these numbers against spend/ledger.ts.

/** money() as the spend gate prints it: at most four decimals. */
export const gateMoney = (n) => String(Number(Number(n).toFixed(4)));

export const STAGE_IDS = ['intake', 'breakdown', 'sketch', 'bible', 'keyframes', 'motion', 'sound', 'assemble', 'export'];

export const bibleEntries = (p) => [...p.bible.characters, ...p.bible.locations, ...p.bible.styles];

/** A unit is out of review when its row left the shot list: its own `source.removed_at`, else its owner's (as decisions/fold.ts removedAt). */
export function removedAt(p, u) {
  const own = u.source?.removed_at;
  if (own !== undefined) return own;
  if (u.owner === undefined) return undefined;
  return unitsById(p).get(u.owner)?.source?.removed_at;
}

export function unitsById(p) {
  const m = new Map();
  for (const u of [...p.shots, ...bibleEntries(p), ...p.assets]) m.set(u.id, u);
  return m;
}

const ran = (p, job) => p.ledger.some((e) => e.job === job.id && (e.status === 'submitted' || e.status === 'done'));
export const bound = (job) => (job.approved_max ?? job.estimate);

/** The money a spend gate must show. */
export function expectedMoney(p) {
  const done = p.ledger.filter((e) => e.status === 'done').reduce((a, e) => a + (e.actual ?? 0), 0);
  const sunk = p.ledger.filter((e) => e.status === 'failed' || e.status === 'cancelled').reduce((a, e) => a + (e.actual ?? 0), 0);
  const inFlight = p.ledger.filter((e) => e.status === 'submitted').reduce((a, e) => a + (e.estimate ?? 0), 0);
  const committed = p.pending_spend.filter((j) => j.status === 'approved' && !ran(p, j)).reduce((a, j) => a + bound(j), 0);
  const awaiting = p.pending_spend.filter((j) => j.status === 'awaiting-approval').reduce((a, j) => a + j.estimate, 0);
  const b = p.budget;
  return {
    currency: b?.currency ?? null,
    cap: b ? b.cap : null,
    spent: b ? b.spent : null,
    sunk,
    inFlight,
    leftIfApproved: b ? b.cap - done - sunk - inFlight - committed - awaiting : null,
    ledgerTotal: p.ledger.reduce((a, e) => a + (e.actual ?? 0), 0),
    jobs: p.pending_spend.map((j) => ({ id: j.id, estimate: j.estimate, bound: bound(j), status: j.status, stage: j.stage })),
  };
}

const TIER_TREATMENT = { A: 'still-move', B: 'still-move', C: 'still' };
/** motion/treatment.ts#treatmentOf, in plain JS. */
const treatmentOf = (s) => s.treatment ?? TIER_TREATMENT[s.tier] ?? (s.source?.kind === 'sheet' ? 'still' : undefined);
const spoken = (p, s) => (s.lines ?? []).some((l) => l.kind === 'spoken' && (p.audio?.lines ?? []).some((x) => x.id === l.id && x.kind === 'spoken'));

/**
 * An idle motion unit (motion/stage.ts#isIdleMotionUnit, WP-32): a clip, lip-sync or line cut kept although its shot no
 * longer asks for it. Like a removed row, it is shown but never counted in "your move".
 */
export function isIdleMotionUnit(p, a) {
  if (a.stage !== 'motion') return false;
  const tags = a.tags ?? [];
  const kind = a.kind === 'lipsync' && tags.includes('lipsync') ? 'lipsync' : tags.includes('lipsync-audio') ? 'cut' : a.kind !== 'lipsync' && tags.includes('clip') ? 'clip' : undefined;
  if (kind === undefined) return false;
  const s = p.shots.find((x) => x.id === a.owner);
  if (!s) return true;
  if (kind === 'clip') { const t = treatmentOf(s); return !(t === undefined || t === 'video'); }
  return !((s.treatment === 'lipsync' || s.treatment === 'video') && spoken(p, s));
}

/** The counts a "your move" summary must show. */
export function expectedYourMove(p) {
  const assetIds = new Set(p.assets.map((a) => a.id));
  const live = (u) => removedAt(p, u) === undefined && !isIdleMotionUnit(p, u);
  return {
    'waiting-shots': p.shots.filter((s) => live(s) && s.status === 'pending-review').length,
    'waiting-spend': p.pending_spend.filter((j) => j.status === 'awaiting-approval').length,
    'waiting-other':
      p.assets.filter((a) => live(a) && a.status === 'pending-review').length +
      bibleEntries(p).filter((e) => live(e) && e.status === 'pending-review' && !e.refs.some((r) => assetIds.has(r))).length,
  };
}

/** The canonical approve-spend text a conforming view writes (spend/gate.ts canApprove). */
export const approveSpendText = (p, job) => `approve ${gateMoney(bound(job))} ${p.budget?.currency ?? 'USD'}`;

/**
 * A second project with different numbers, so a summary or an amount typed
 * into the page (instead of derived from the data) shows up as wrong.
 */
export function mutateProject(p) {
  const q = structuredClone(p);
  const shot = q.shots.find((s) => s.status === 'approved');
  if (shot) shot.status = 'pending-review';
  const job = q.pending_spend.find((j) => j.status === 'awaiting-approval');
  if (job) job.estimate = Number((job.estimate + 0.0525).toFixed(4));
  if (q.budget) q.budget.cap = q.budget.cap + 5;
  const asset = q.assets.find((a) => a.status === 'pending-review');
  if (asset) asset.status = 'approved';
  return q;
}

// ─────────────────────────────────────────────────────────────────────────
// Confirmed batch approval (views/contract.md §4 "Batch approval")
// ─────────────────────────────────────────────────────────────────────────

/** The ending every decision of one batch carries: ` · batch <uuid>` (decisions/fold.ts#BATCH_TEXT). */
export const BATCH_TEXT = / · batch ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const batchOf = (d) => BATCH_TEXT.exec(typeof d?.text === 'string' ? d.text : '')?.[1];

/** A shot's part: its own, else its scene's (decisions/gates.ts, the default board). */
export const partOf = (p, s) => s.part ?? p.scenes.find((sc) => sc.id === s.scene)?.part ?? null;
export const partsOf = (p) => [...new Set([...p.shots.map((s) => partOf(p, s)), ...p.scenes.map((sc) => sc.part ?? null)].filter((x) => x != null))];

/** A batch scope a view may offer: `bible`, or `part:<id>` for a part the project has. */
export const isBatchScope = (p, scope) => scope === 'bible' || (/^part:/.test(scope ?? '') && partsOf(p).includes(scope.slice(5)));

/**
 * What a confirmed batch over one scope may approve, by the project's data: live units
 * `pending-review` (never `needs-rework`, never with an open `block` quality flag), and of assets only those with a file.
 * - `part:<id>`: the part's shots.
 * - `bible`: bible entries with no asset of their own, and assets of the bible (stage `bible`, or owned by a bible entry); cards and intake documents are not bible.
 */
export function batchUnits(p, scope) {
  const live = (u) => removedAt(p, u) === undefined && !isIdleMotionUnit(p, u);
  const waiting = (u) => live(u) && u.status === 'pending-review' && !hasBlockFlag(u);
  if (scope === 'bible') {
    const assetIds = new Set(p.assets.map((a) => a.id));
    const entries = bibleEntries(p);
    const entryIds = new Set(entries.map((e) => e.id));
    const owned = (a) => entryIds.has(a.owner) || entries.some((e) => e.refs.includes(a.id));
    return [
      ...entries.filter((e) => waiting(e) && !e.refs.some((r) => assetIds.has(r))).map((e) => e.id),
      ...p.assets.filter((a) => waiting(a) && a.kind !== 'card' && a.stage !== 'intake' && (a.stage === 'bible' || owned(a)) && !!a.file).map((a) => a.id),
    ];
  }
  if (/^part:/.test(scope ?? '')) {
    const pt = scope.slice(5);
    return p.shots.filter((s) => waiting(s) && partOf(p, s) === pt).map((s) => s.id);
  }
  return [];
}

/**
 * The project check-view runs the batch checks on: the fixture with parts (when it
 * has none), so a part batch has more than one shot and skips one sent back, and one
 * more bible item waiting, with a file, beside one without (which a batch must leave out).
 */
export function batchProject(p) {
  const q = structuredClone(p);
  if (partsOf(q).length === 0 && q.scenes.length) {
    const last = q.scenes.length - 1;
    q.scenes.forEach((sc, i) => { sc.part = i === Math.max(0, last - 1) && q.scenes.length > 1 ? 'P2' : 'P1'; });
  }
  const assetIds = new Set(q.assets.map((a) => a.id));
  const loneEntry = bibleEntries(q).find((e) => e.status === 'pending' && !e.refs.some((r) => assetIds.has(r)) && e.source?.removed_at === undefined);
  if (loneEntry) loneEntry.status = 'pending-review';
  const fileless = q.assets.filter((a) => a.status === 'pending-review' && !a.file && a.kind !== 'card' && a.stage !== 'intake');
  if (fileless.length > 1) { const a = fileless[fileless.length - 1]; a.file = { uri: `bible/${a.id}.png`, mime: 'image/png' }; }
  return q;
}

/** Open quality flags on a unit's current stage (lib/state.md §Quality flags). */
export const openFlags = (u) => (u.by_stage?.[u.stage]?.flags ?? []).filter((f) => f.status === 'open');
/** An open `block` flag keeps a unit out of every batch (decisions/fold.ts, batch-ineligible). */
export const hasBlockFlag = (u) => openFlags(u).some((f) => f.severity === 'block');

/** The E01 findings that made quality flags (default-board@0.9), as fixture flags. */
export const FLAG_EXAMPLES = [
  { kind: 'anatomy', severity: 'warn', text: 'Long slender neck', suggested_change: 'Shorter, thicker neck in proportion to the head and shoulders, as in the bible portrait.' },
  { kind: 'style-drift', severity: 'warn', text: 'Near-photographic, not clay style', suggested_change: 'Make it read as hand-made clay: soft matte surfaces, visible sculpting, no photographic skin or lens detail.' },
  { kind: 'wardrobe-logo', severity: 'warn', text: 'Patch on cap; bible says plain cap', suggested_change: 'Plain cap with no patch, logo or lettering.' },
  { kind: 'anatomy', severity: 'warn', text: 'Tom looks short; should be ~6\'5"', suggested_change: 'Tom is about 6\'5": tall, a head above the people beside him.' },
  { kind: 'text-in-image', severity: 'info', text: 'Name label dropped from turnaround', suggested_change: 'Keep the name label under the turnaround, as on the other sheets.' },
];

/**
 * The project check-view runs the flag checks on: the fixture with open quality flags on every unit
 * waiting for review (a file given to each such asset), drawn from FLAG_EXAMPLES. Ids are fixed so
 * the check is repeatable.
 */
export function flagProject(p) {
  const q = structuredClone(p);
  let n = 0;
  const add = (u, file) => {
    const ex = FLAG_EXAMPLES[n % FLAG_EXAMPLES.length];
    const id = `flag_${(0xc0ffee00 + n).toString(16)}`;
    n++;
    const rec = ((u.by_stage ??= {})[u.stage] ??= { status: u.status });
    (rec.flags ??= []).push({ id, ts: '2026-11-14T09:00:00Z', stage: u.stage, ...ex, evidence: { uri: file ?? `board/panels/${u.id}-${u.stage}.svg` }, source: 'agent:check-view', status: 'open' });
  };
  for (const s of q.shots) if (s.status === 'pending-review' && removedAt(q, s) === undefined) add(s);
  for (const a of q.assets) {
    if (a.status !== 'pending-review' || removedAt(q, a) !== undefined || a.kind === 'card' || a.stage === 'intake') continue;
    a.file ??= { uri: `bible/${a.id}.png`, mime: 'image/png' };
    add(a, a.file.uri);
  }
  return q;
}
