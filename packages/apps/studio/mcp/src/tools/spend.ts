/**
 * `spend.*` tools — the paid-render ceiling (WP-12 / Plan 16 D-b).
 *
 * READ-ONLY, and that is the design. There is exactly one tool here and it
 * reports; there is no `spend.set_ceiling`, no `spend.approve`, no override
 * argument on any render or anchor tool. A ceiling an agent can raise is not a
 * ceiling — it is a speed bump with a bypass documented next to it.
 *
 * Raising the ceiling is a human act, by one of two routes:
 *   1. edit `metadata.spend_ceiling_usd` in the project's `storyboard.json`
 *   2. set `STUDIO_SPEND_CEILING_USD` in the sidecar's environment
 *
 * This mirrors `Cell.approved`: the agent proposes, the human approves.
 *
 * When `composition.render` or `anchor.generate` comes back with
 * `spend-ceiling-exceeded`, the correct behaviour is to STOP and report the
 * numbers to the human — not to retry with a cheaper model, a shorter clip, or
 * a different project id.
 */

import { SidecarClient } from '../sidecar-client.js';
import { callSidecar } from './project.js';
import type { ToolDef } from './types.js';

export function spendTools(sidecar: SidecarClient): ToolDef[] {
  return [
    {
      name: 'spend.status',
      description:
        "Report a project's cumulative AI-render spend against its ceiling. Returns { ok, ceiling_usd, ceiling_source ('env'|'project'|'default'), settled_usd (finished work), reserved_usd (queued/in-flight work, at estimate), committed_usd (settled+reserved — what the ceiling is compared against), remaining_usd, entries[] }. Covers BOTH paid doors: queued renders on metered engines and anchor.generate stills. Note that most fal endpoints do not report a cost, so entries settle at their invoice-derived ESTIMATE rather than at zero — committed_usd is the honest figure to plan against. Read-only: the ceiling cannot be raised from a tool call. If a render was refused with spend-ceiling-exceeded, report these numbers to the human and stop; do not retry with different arguments.",
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          limit: {
            type: 'number',
            description: 'Max ledger entries to return, newest first. Default 200.',
          },
        },
        required: ['projectId'],
        additionalProperties: false,
      },
      handler: (args) =>
        callSidecar(sidecar, 'spend.status', { projectId: args.projectId, limit: args.limit }),
    },
  ];
}
