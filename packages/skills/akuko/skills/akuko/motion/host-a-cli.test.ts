// R-11 through the motion command line on host A (AKUKO_HOST=A): quote, reserve (nothing sent), send (once).
// The network is a mocked Kling API installed as globalThis.fetch; the keys are dummies set only for this test.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createLocalHost, serializeProject } from '../hosts/local.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { keyframeAssets } from '../keyframes/plan.ts';
import { PNG_BYTES } from '../providers/gemini-image/__fixtures__/mock-net.ts';
import { mockKling } from '../providers/__fixtures__/direct-net.ts';
import { run } from './cli.ts';
import { approveSpend, keyframesApproved } from './__fixtures__/project.ts';

const T = () => new Date('2026-11-12T10:00:00Z');
const VARS = ['AKUKO_HOST', 'KLING_ACCESS_KEY', 'KLING_SECRET_KEY'] as const;
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
let net = mockKling();

beforeEach(() => {
  for (const v of VARS) saved[v] = process.env[v];
  process.env.AKUKO_HOST = 'A';
  delete process.env.KLING_ACCESS_KEY;
  delete process.env.KLING_SECRET_KEY;
  net = mockKling();
  globalThis.fetch = net.fetch as typeof fetch;
});
afterEach(() => {
  for (const v of VARS) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; }
  globalThis.fetch = realFetch;
});

async function folder() {
  const dir = await mkdtemp(join(tmpdir(), 'akuko-hosta-'));
  const p = keyframesApproved({ budget: { cap: 10, currency: 'USD' } });
  await mkdir(join(dir, 'keyframes'), { recursive: true });
  for (const a of keyframeAssets(p)) {
    a.file = { uri: `keyframes/${a.id}.png`, mime: 'image/png' };
    await writeFile(join(dir, 'keyframes', `${a.id}.png`), PNG_BYTES);
  }
  await writeFile(join(dir, 'akuko.json'), serializeProject(p));
  return { dir, host: createLocalHost({ projectDir: dir, now: T }) };
}

describe('motion cli on host A: a paid direct API under R-11', () => {
  it('quote (no key), reserve (no key, nothing sent), send with the pasted key, once', async () => {
    const { dir, host } = await folder();
    await run(['plan', '--project', dir], T);
    const step = ['step', '--project', dir, '--provider', 'kling-video'];

    const quote = await run(step, T);
    assert.equal(quote.code, 0, quote.out);
    assert.match(quote.out, /Spend check .* Reply "approve 0\.7 USD"/);
    const jobId = (await host.readState()).pending_spend[0]!.id;
    await host.writeState(approveSpend(await host.readState(), jobId, 'motion').project);

    const bare = await run(step, T);
    assert.equal(bare.code, 1);
    assert.match(bare.out, /paid-direct-on-host-a/);

    const reserve = await run([...step, '--key-source', 'pasted-this-chat', '--phase', 'reserve'], T);
    assert.equal(reserve.code, 0, reserve.out);
    assert.match(reserve.out, /Reserved 0\.7 USD .* Nothing was sent/);
    assert.equal(net.calls.length, 0);
    let p = await host.readState();
    assert.equal(p.ledger.length, 1);
    assert.equal(p.ledger[0]!.reserved, true);
    assert.deepEqual(checkIntegrity(p), []);

    const noKey = await run([...step, '--key-source', 'pasted-this-chat', '--phase', 'send'], T);
    assert.match(noKey.out, /Setup needed: KLING_ACCESS_KEY and KLING_SECRET_KEY are not set/);
    assert.equal(net.calls.length, 0);

    process.env.KLING_ACCESS_KEY = 'dummy-access';
    process.env.KLING_SECRET_KEY = 'dummy-secret';
    const send = await run([...step, '--key-source', 'pasted-this-chat', '--phase', 'send'], T);
    assert.equal(send.code, 0, send.out);
    assert.match(send.out, /Done: 1 clip recorded/);
    assert.ok(!send.out.includes('dummy-secret') && !send.out.includes('dummy-access'), 'no key in the output');
    p = await host.readState();
    assert.equal(p.ledger[0]!.status, 'done');
    assert.equal(p.ledger[0]!.reserved, undefined);
    assert.equal(p.budget?.spent, 0.7);
    assert.ok(!JSON.stringify(p).includes('dummy-secret') && !JSON.stringify(p).includes('dummy-access'), 'no key in akuko.json');
    assert.deepEqual(checkIntegrity(p), []);

    const posts = net.calls.filter((c) => c.method === 'POST').length;
    const again = await run([...step, '--key-source', 'pasted-this-chat', '--phase', 'send'], T);
    assert.doesNotMatch(again.out, /Done:/, 'the made shot is not sent again (the next shot only gets its own spend line)');
    assert.equal(net.calls.filter((c) => c.method === 'POST').length, posts, 'nothing sent twice');
  });

  it('rejects a key source other than pasted-this-chat and an unknown phase', async () => {
    const { dir } = await folder();
    assert.equal((await run(['step', '--project', dir, '--provider', 'kling-video', '--key-source', 'env'], T)).code, 2);
    assert.equal((await run(['step', '--project', dir, '--provider', 'kling-video', '--phase', 'now'], T)).code, 2);
  });
});
