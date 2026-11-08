// The paid stages resolve reference images against the project folder, not the
// process cwd: the bible's second wave and a key frame, run from an unrelated
// folder with a mocked network and a dummy key. Nothing here makes a live call.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createLocalHost, serializeProject } from '../hosts/local.ts';
import { PNG_B64, PNG_BYTES, mockGemini } from '../providers/gemini-image/__fixtures__/mock-net.ts';
import { bibleApproved } from '../keyframes/__fixtures__/project.ts';
import { run as keyframesRun } from '../keyframes/cli.ts';
import { run as bibleRun } from './cli.ts';
import { approve, approveSpend, breakdownApproved } from './__fixtures__/project.ts';

const T = () => new Date('2026-11-08T10:00:00Z');
const BUDGET = { cap: 100, currency: 'USD' };

/** Run `fn` from an unrelated cwd with a dummy key and a mocked network; restore everything. */
async function offline<R>(net: { fetch: typeof fetch }, fn: () => Promise<R>): Promise<R> {
  const elsewhere = await mkdtemp(join(tmpdir(), 'akuko-cwd-'));
  const cwd = process.cwd();
  const realFetch = globalThis.fetch;
  const key = process.env.GEMINI_API_KEY;
  try {
    process.chdir(elsewhere);
    globalThis.fetch = net.fetch;
    process.env.GEMINI_API_KEY = 'test-key';
    return await fn();
  } finally {
    process.chdir(cwd);
    globalThis.fetch = realFetch;
    if (key === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = key;
  }
}

const hasRef = (calls: { body: unknown }[]): boolean => calls.some((c) => JSON.stringify(c.body).includes(PNG_B64));

describe('paid steps from outside the project folder', () => {
  it('bible wave 2 attaches the approved wave-1 image', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'akuko-bible-cwd-'));
    await writeFile(join(dir, 'akuko.json'), serializeProject(breakdownApproved({ budget: BUDGET })));
    const host = createLocalHost({ projectDir: dir, now: T });
    const net = mockGemini();
    await offline(net, async () => {
      assert.equal((await bibleRun(['plan', '--project', dir], T)).code, 0);
      const step = async () => {
        let r = await bibleRun(['step', '--project', dir, '--provider', 'gemini-image'], T);
        while (/^Spend check/.test(r.out)) {
          const pending = (await host.readState()).pending_spend.at(-1)!;
          await host.writeState(approveSpend(await host.readState(), pending.id).project);
          r = await bibleRun(['step', '--project', dir, '--provider', 'gemini-image'], T);
        }
        assert.equal(r.code, 0, r.out);
        return r;
      };
      await step(); // wave 1: nothing to attach
      assert.equal(hasRef(net.calls), false);
      const p = await host.readState();
      const wave1 = p.assets.filter((a) => a.status === 'pending-review').map((a) => a.id);
      assert.ok(wave1.length > 0, 'wave 1 produced files');
      await host.writeState(approve(p, wave1, 'bible').project);
      await bibleRun(['sync', '--project', dir], T);
      const second = await step(); // wave 2: attaches the lookbook
      assert.doesNotMatch(second.out, /ENOENT/);
      assert.ok(hasRef(net.calls), 'the request body carries the reference image');
    });
  });

  it('a key frame attaches its approved bible images', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'akuko-kf-cwd-'));
    const p = bibleApproved({ budget: BUDGET });
    for (const a of p.assets) {
      if (a.file?.uri.startsWith('mem://')) {
        const uri = `bible/${a.id}.png`;
        a.file = { ...a.file, uri };
        await mkdir(join(dir, 'bible'), { recursive: true });
        await writeFile(join(dir, uri), PNG_BYTES);
      }
    }
    await writeFile(join(dir, 'akuko.json'), serializeProject(p));
    const host = createLocalHost({ projectDir: dir, now: T });
    const net = mockGemini();
    await offline(net, async () => {
      assert.equal((await keyframesRun(['plan', '--project', dir], T)).code, 0);
      await keyframesRun(['step', '--project', dir, '--provider', 'gemini-image'], T);
      const pending = (await host.readState()).pending_spend[0];
      assert.ok(pending, 'the spend is put in front of the person first');
      assert.equal(net.calls.length, 0);
      await host.writeState(approveSpend(await host.readState(), pending.id, 'keyframes').project);
      const r = await keyframesRun(['step', '--project', dir, '--provider', 'gemini-image'], T);
      assert.equal(r.code, 0, r.out);
      assert.ok(hasRef(net.calls), 'the request body carries the reference image');
    });
  });
});
