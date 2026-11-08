/**
 * One akuko process running one paid job through the spend gate on a shared
 * project folder (host B). hosts/state-race.test.ts starts two of these at
 * once to prove that two processes cannot overrun the cap or lose each
 * other's ledger entries (Wave 3 review, finding 1; lib/spend.md).
 *
 * Its host waits after its first read until every worker has read, so both
 * gates start from the same `akuko.json`: the race happens every run.
 *
 *   node --experimental-strip-types race-worker.ts <project> <job id> <unit> <barrier dir> <workers>
 */

import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AkukoProject } from '../../schema/akuko-project.ts';
import { createSpendGate } from '../../spend/gate.ts';
import { createFakePaid } from '../../spend/__fixtures__/fake-paid.ts';
import { LocalHost } from '../local.ts';

const [projectDir, jobId, unit, barrier, workers] = process.argv.slice(2) as [string, string, string, string, string];

class BarrierHost extends LocalHost {
  private waited = false;
  override async readState(): Promise<AkukoProject> {
    const p = await super.readState();
    if (!this.waited) {
      this.waited = true;
      writeFileSync(join(barrier, `${jobId}.${process.pid}.ready`), '');
      const deadline = Date.now() + 20_000;
      while (readdirSync(barrier).filter((f) => f.endsWith('.ready')).length < Number(workers)) {
        if (Date.now() > deadline) throw new Error('race-worker: the other worker never read state');
        await sleep(5);
      }
    }
    return p;
  }
}

const host = new BarrierHost({ projectDir });
const fake = createFakePaid(host);
const gate = createSpendGate({ host, providers: [fake.provider], level: 'B' });
try {
  const r = await gate.run({
    id: jobId,
    stage: 'keyframes',
    kind: 'image',
    provider: fake.provider.id,
    label: `Key frame ${unit}`,
    items: [{ unit, prompt: 'A long dark hallway', output: 'keyframe' }],
  });
  const out = r.status === 'refused' ? { status: r.status, code: r.refusal.code } : { status: r.status };
  process.stdout.write(`${JSON.stringify({ job: jobId, ...out, providerCalls: fake.submitted.length })}\n`);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ job: jobId, status: 'threw', error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), barrierLeft: existsSync(barrier) })}\n`);
}
