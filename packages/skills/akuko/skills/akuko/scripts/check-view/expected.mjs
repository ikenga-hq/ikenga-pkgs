// What a conforming view must show for a given project, computed from the
// data the same way the spend gate and folding do (spend/ledger.ts,
// decisions/fold.ts). Plain JS so check-view runs without a TypeScript step;
// scripts/check-view.test.ts checks these numbers against spend/ledger.ts.

/** money() as the spend gate prints it: at most four decimals. */
export const gateMoney = (n) => String(Number(Number(n).toFixed(4)));

export const STAGE_IDS = ['intake', 'breakdown', 'sketch', 'bible', 'keyframes', 'motion', 'sound', 'assemble', 'export'];

export const bibleEntries = (p) => [...p.bible.characters, ...p.bible.locations, ...p.bible.styles];

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

/** The counts a "your move" summary must show. */
export function expectedYourMove(p) {
  const assetIds = new Set(p.assets.map((a) => a.id));
  return {
    'waiting-shots': p.shots.filter((s) => s.status === 'pending-review').length,
    'waiting-spend': p.pending_spend.filter((j) => j.status === 'awaiting-approval').length,
    'waiting-other':
      p.assets.filter((a) => a.status === 'pending-review').length +
      bibleEntries(p).filter((e) => e.status === 'pending-review' && !e.refs.some((r) => assetIds.has(r))).length,
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
