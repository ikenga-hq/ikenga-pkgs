// akuko — R-11, host A (claude.ai): a paid direct API runs only with a key pasted for this chat, reserved first
// (saved to the board) and sent second. Network is mocked; nothing here calls a provider.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AkukoProject } from '../schema/akuko-project.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import type { Job } from '../providers/contract.ts';
import { createFakeHost, tinyProject } from '../providers/__fixtures__/fake-host.ts';
import { REF_URI } from '../providers/gemini-image/__fixtures__/mock-net.ts';
import { mockKling } from '../providers/__fixtures__/direct-net.ts';
import { createKlingVideoProvider } from '../providers/kling-video/index.ts';
import { keyframeJobId } from '../keyframes/plan.ts';
import { PASTED_KEY, createSpendGate, isPhaseStop, phasedGateOptions, type SpendGateOptions } from './gate.ts';

const T0 = Date.parse('2026-11-12T10:00:00Z');
const withBudget = (p: AkukoProject): AkukoProject => ({ ...p, budget: { cap: 20, currency: 'USD', spent: 0 } });

const job = (): Job => ({
  id: 'job_mo_hosta_r1',
  stage: 'motion',
  kind: 'video',
  provider: 'kling-video',
  label: 'Clip for shot 1',
  items: [{ unit: 'sc1_sh1', prompt: 'Mara walks along the pier', output: 'clip', duration_s: 5, refs: [{ id: 'kf1', uri: REF_URI, role: 'start-frame' }] }],
});

/** One project, one network, one clock; each `gate()` is a fresh command run (as each CLI call is). */
function world() {
  const log: string[] = [];
  const net = mockKling();
  const fetch: typeof net.fetch = async (u, i) => { log.push(`fetch ${new URL(String(u)).host}`); return net.fetch(u, i); };
  const host = createFakeHost(withBudget(tinyProject()));
  const write = host.writeState.bind(host);
  host.writeState = async (p) => { log.push('write'); return write(p); };
  let clock = T0;
  const provider = createKlingVideoProvider(host, { fetch, accessKey: 'ak', secretKey: 'sk', now: () => new Date(clock).toISOString() });
  const gate = (o: Partial<SpendGateOptions> = {}) => createSpendGate({ host, providers: [provider], level: 'A', now: () => new Date(clock).toISOString(), ...o });
  const approve = (): void => {
    const p = host.peek();
    host.set({ ...p, pending_spend: p.pending_spend.map((x) => ({ ...x, status: 'approved' as const })) });
  };
  return { log, net, host, gate, approve, tick: (ms: number) => { clock += ms; } };
}

describe('host A: direct providers under R-11', () => {
  it('quoting is free and works on host A (the spend line and pending entry), with no key and no network', async () => {
    const w = world();
    const q = await w.gate().quote(job());
    assert.equal(q.paid, true);
    assert.match(q.confirmation ?? '', /approve 0\.35 USD/);
    assert.equal(w.host.peek().pending_spend.length, 1);
    assert.equal(w.net.calls.length, 0);
  });

  it('without the pasted-key acknowledgement a run is refused and points to the flow', async () => {
    const w = world();
    await w.gate().quote(job());
    w.approve();
    const r = await w.gate().run(job());
    assert.ok(r.status === 'refused' && r.refusal.code === 'paid-direct-on-host-a');
    assert.match(r.status === 'refused' ? r.refusal.message : '', /visible in this chat's history/);
    assert.match(r.status === 'refused' ? r.refusal.message : '', /probe/);
    assert.equal(w.net.calls.length, 0);
    assert.deepEqual(w.host.peek().ledger, []);
  });

  it('with the acknowledgement but no phase it is still refused: the board must hold the reservation first', async () => {
    const w = world();
    await w.gate().quote(job());
    w.approve();
    const r = await w.gate({ keySource: PASTED_KEY }).run(job());
    assert.ok(r.status === 'refused' && r.refusal.code === 'paid-direct-on-host-a' && /two phases/.test(r.refusal.message));
    assert.equal(w.net.calls.length, 0);
  });

  it('reserve writes the reservation and sends nothing; send clears the mark and saves it BEFORE the call; collect settles', async () => {
    const w = world();
    await w.gate().quote(job());
    w.approve();

    const r1 = await w.gate({ keySource: PASTED_KEY, phase: 'reserve' }).run(job());
    assert.ok(r1.status === 'refused' && r1.refusal.code === 'reserved-not-sent' && isPhaseStop(r1.refusal.code));
    assert.match(r1.status === 'refused' ? r1.refusal.message : '', /Nothing was sent/);
    assert.equal(w.net.calls.length, 0);
    const reserved = w.host.peek().ledger;
    assert.equal(reserved.length, 1);
    assert.equal(reserved[0]!.status, 'submitted');
    assert.equal(reserved[0]!.reserved, true);
    assert.deepEqual(checkIntegrity(w.host.peek()), []);

    // The agent saves this to the board's database here. Then, in the same chat:
    w.log.length = 0;
    const r2 = await w.gate({ keySource: PASTED_KEY, phase: 'send' }).run(job());
    assert.equal(r2.status, 'submitted', JSON.stringify(r2));
    assert.equal(w.log[0], 'write', `the unsent mark is cleared and saved before any request: ${w.log.join(', ')}`);
    assert.ok(w.log.indexOf('fetch api-singapore.klingai.com') > 0);
    const sent = w.host.peek().ledger[0]!;
    assert.equal(sent.status, 'submitted');
    assert.equal(sent.reserved, undefined);
    if (r2.status !== 'submitted') return;
    assert.deepEqual(r2.handle.ledger, [sent.id]);

    const c = await w.gate({ keySource: PASTED_KEY, phase: 'send' }).collect(r2.handle);
    assert.equal(c.status.state, 'done');
    const p = w.host.peek();
    assert.equal(p.ledger[0]!.status, 'done');
    assert.equal(p.budget?.spent, 0.35);
    assert.deepEqual(checkIntegrity(p), []);
  });

  it('a reservation is sent once: a second send is refused and makes no request', async () => {
    const w = world();
    await w.gate().quote(job());
    w.approve();
    await w.gate({ keySource: PASTED_KEY, phase: 'reserve' }).run(job());
    assert.equal((await w.gate({ keySource: PASTED_KEY, phase: 'send' }).run(job())).status, 'submitted');
    const posts = w.net.calls.filter((c) => c.method === 'POST').length;
    const again = await w.gate({ keySource: PASTED_KEY, phase: 'send' }).run(job());
    assert.ok(again.status === 'refused' && again.refusal.code === 'already-sent', JSON.stringify(again));
    assert.equal(w.net.calls.filter((c) => c.method === 'POST').length, posts);
  });

  it('send with no reservation is refused; a reservation older than the limit is not sent', async () => {
    const w = world();
    await w.gate().quote(job());
    w.approve();
    const none = await w.gate({ keySource: PASTED_KEY, phase: 'send' }).run(job());
    assert.ok(none.status === 'refused' && none.refusal.code === 'not-reserved');
    await w.gate({ keySource: PASTED_KEY, phase: 'reserve' }).run(job());
    w.tick(16 * 60 * 1000);
    const stale = await w.gate({ keySource: PASTED_KEY, phase: 'send' }).run(job());
    assert.ok(stale.status === 'refused' && stale.refusal.code === 'reservation-stale' && /dashboard/.test(stale.refusal.message));
    assert.equal(w.net.calls.length, 0);
  });

  it('release cancels an unsent reservation at no cost, and the job can be reserved again', async () => {
    const w = world();
    await w.gate().quote(job());
    w.approve();
    await w.gate({ keySource: PASTED_KEY, phase: 'reserve' }).run(job());
    const rel = await w.gate({ keySource: PASTED_KEY, phase: 'release' }).run(job());
    assert.ok(rel.status === 'refused' && rel.refusal.code === 'reservation-released' && isPhaseStop(rel.refusal.code));
    const l = w.host.peek().ledger;
    assert.equal(l[0]!.status, 'cancelled');
    assert.equal(l[0]!.reserved, undefined);
    assert.equal(l[0]!.actual, undefined);
    const again = await w.gate({ keySource: PASTED_KEY, phase: 'reserve' }).run(job());
    assert.ok(again.status === 'refused' && again.refusal.code === 'reserved-not-sent');
    assert.equal(w.host.peek().ledger.length, 2);
    assert.equal(w.net.calls.length, 0);
  });

  it('an unsent reservation does not count as a run, so the send phase builds the same job id', async () => {
    const p = withBudget(tinyProject());
    const id = keyframeJobId(p, ['sc1_sh1'], 'gemini-image', 'm');
    const withReservation: AkukoProject = { ...p, ledger: [{ id: `${id}.sc1_sh1.1`, ts: '2026-11-12T10:00:00Z', provider: 'gemini-image', unit: 'sc1_sh1', job: id, estimate: 0.1, status: 'submitted', reserved: true }] };
    assert.equal(keyframeJobId(withReservation, ['sc1_sh1'], 'gemini-image', 'm'), id);
    const sent: AkukoProject = { ...withReservation, ledger: withReservation.ledger.map(({ reserved: _r, ...e }) => e) };
    assert.notEqual(keyframeJobId(sent, ['sc1_sh1'], 'gemini-image', 'm'), id);
  });

  it('the phases change nothing on hosts B and C beyond what they say', async () => {
    const w = world();
    const gateB = (o: Partial<SpendGateOptions> = {}) => w.gate({ level: 'B', ...o });
    await gateB().quote(job());
    w.approve();
    assert.equal((await gateB().run(job())).status, 'submitted', 'no flags needed on B');
  });

  it('flag parsing: only pasted-this-chat and the three phases are accepted; the key is never a flag', () => {
    const get = (m: Record<string, string>) => (n: string) => m[n];
    assert.deepEqual(phasedGateOptions(get({ 'key-source': PASTED_KEY, phase: 'send' })), { keySource: PASTED_KEY, phase: 'send' });
    assert.ok('error' in phasedGateOptions(get({ 'key-source': 'env' })));
    assert.ok('error' in phasedGateOptions(get({ phase: 'go' })));
    assert.deepEqual(phasedGateOptions(get({})), {});
  });
});
