/**
 * akuko — host C, ikenga (the Ikenga shell, optionally with Studio).
 *
 * Ikenga's engine is Claude Code running locally, so state, assets and views
 * use the same project folder as host B (`LocalHost`). What C adds, and where
 * it is filled in:
 *   - decisions arrive from an Ikenga artifact over the bridge and are
 *     mirrored to `decisions.jsonl` → `decisions/ikenga.ts` (WP-07a);
 *   - views open in an Ikenga pane and assets reach Studio through the bridge,
 *     with Studio owning render state → WP-16 (Phase 3).
 * Until then the C-specific methods behave like B's and say so.
 *
 * Bridge facts this relies on are recorded in lib/hosts.md §Host-capability
 * note (row C), each with its source path.
 */

import type { Decision } from '../schema/akuko-project.ts';
import { LocalHost, type LocalHostOptions } from './local.ts';
import { decisionsNotImplemented } from './shared.ts';
import type { HostAdapter } from './types.ts';

export class IkengaHost extends LocalHost {
  /** Delegates to `decisions/ikenga.ts` (bridge-published state mirrored to `decisions.jsonl`) — WP-07a. */
  override async readDecisions(_since?: string): Promise<Decision[]> {
    return decisionsNotImplemented('C');
  }
}

export function createIkengaHost(opts: LocalHostOptions): IkengaHost {
  return new IkengaHost(opts);
}

/**
 * The adapter for a Node runtime: `IkengaHost` when detection says C,
 * `LocalHost` on B. On A (e.g. Node inside claude.ai's cloud workspace) it
 * throws: the project lives in the artifact database there, and a project
 * folder in that workspace would vanish with the chat — use
 * `ClaudeArtifactHost`.
 */
export async function createNodeHost(opts: LocalHostOptions): Promise<HostAdapter> {
  const local = new LocalHost(opts);
  const { level } = await local.detect();
  if (level === 'A') {
    throw new Error('akuko: host A (claude-artifact) — the project lives in the artifact database; use ClaudeArtifactHost, not a project folder');
  }
  return level === 'C' ? createIkengaHost(opts) : local;
}
