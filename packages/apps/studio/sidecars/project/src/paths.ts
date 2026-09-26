/**
 * Path canonicalisation for project identity.
 *
 * Its own module because `index.ts` starts the RPC loop on import — anything
 * that wants to unit-test path handling cannot reach in there without booting a
 * sidecar, and a test that hangs is a test nobody runs.
 *
 * Why this matters beyond tidiness: WP-12's spend ceiling is enforced per
 * `project_id`, and `project_id` is keyed on the path string handed to
 * `project.open`. Before this, `C:/x/y` and `C:\x\y` were two different
 * projects with two ledgers and two ceilings — observed on 2026-09-08 as one
 * Forge directory carrying $1.127 under one id and $0.672 under another.
 * A ceiling you can reset by changing a slash is not a ceiling.
 */

import { resolve } from 'node:path';

/** True when two paths name the same directory, allowing for separator,
 *  redundant-segment and (on Windows) case differences. */
export function samePath(a: string, b: string): boolean {
  const norm = (s: string) => resolve(s).replace(/[\/]+$/, '');
  const A = norm(a);
  const B = norm(b);
  return process.platform === 'win32' ? A.toLowerCase() === B.toLowerCase() : A === B;
}
