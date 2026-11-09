/**
 * The `akuko.json.host` record for the process that is creating a project
 * (Part A note: neither `breakdown/cli.ts new` nor `applySetup` recorded it).
 * Goes through `hosts/detect.ts` unchanged. A Node process cannot see the
 * agent's tool list, so a caller that has it passes `toolNames` (the same
 * names `hosts/detect.ts --tools` takes); without them claude.ai cannot be
 * recognised, but that host has no durable folder and never reaches here.
 */

import type { Host } from '../schema/akuko-project.ts';
import { classifyHost, defaultNodeDeps, probeNode, toHostRecord } from '../hosts/detect.ts';

export function detectHostRecord(toolNames: readonly string[] = []): Host {
  const deps = defaultNodeDeps();
  const capabilities = probeNode({ toolNames: [...toolNames] }, deps);
  return toHostRecord(classifyHost(capabilities, deps.env.AKUKO_HOST), capabilities);
}
