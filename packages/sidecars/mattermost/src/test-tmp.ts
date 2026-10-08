import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Temp directories for the test files. Every directory made here is removed by `sweepTmp`, which each file runs once
 * after its last test. A bridge that was stopped in the last moments of a test can still write a record or a store file
 * a few milliseconds later and so bring its directory back; the sweep waits a beat and removes them all again.
 */
const made = new Set<string>();

export function tmpDir(prefix: string): string {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  made.add(d);
  return d;
}

export async function sweepTmp(settleMs = 300): Promise<void> {
  await new Promise((r) => setTimeout(r, settleMs));
  for (const d of made) rmSync(d, { recursive: true, force: true });
  made.clear();
}
