/**
 * `project.*` tools — thin pass-throughs to the sidecar's project.* RPCs.
 *
 * Every handler funnels through `callSidecar` which converts
 * sidecar-side errors into our `{ ok: false, error, message }` envelope.
 */

import {
  EXTERNAL_CALL_TIMEOUT_MS,
  SidecarClient,
  SidecarRpcError,
  SidecarUnavailableError,
} from '../sidecar-client.js';
import type { OpenProjectRegistry, ToolDef, ToolResult } from './types.js';

export async function callSidecar(
  sidecar: SidecarClient,
  method: string,
  params: unknown,
  timeoutMs?: number,
): Promise<ToolResult> {
  try {
    const r = (await sidecar.call(method, params, { timeoutMs })) as ToolResult;
    return r;
  } catch (e) {
    if (e instanceof SidecarUnavailableError) {
      return { ok: false, error: 'sidecar-unavailable', message: e.message };
    }
    if (e instanceof SidecarRpcError) {
      return { ok: false, error: 'sidecar-rpc-error', message: `${e.code}: ${e.message}` };
    }
    return { ok: false, error: 'internal-error', message: (e as Error).message };
  }
}

export function projectTools(
  sidecar: SidecarClient,
  registry: OpenProjectRegistry,
): ToolDef[] {
  return [
    {
      name: 'project.open',
      description:
        'Open a project on disk. Returns projectId + parsed Project. Runs the '
        + 'WP-04 per-folder trust gate first: a folder the user has already '
        + 'granted opens immediately, an ungranted one pops a native prompt on '
        + "the user's screen and blocks until they answer. Returns "
        + "error:'trust-denied' if they decline, error:'trust-unreachable' if "
        + 'there is no shell to ask.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or cwd-relative project root path.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async handler(args) {
        // Long timeout, not the 30s default: the trust gate this call runs may
        // put a native dialog in front of the user, and a human click is not
        // bounded by our RPC budget. The MCP relay must not be the layer that
        // gives up while the prompt is still on screen — the grant would land
        // anyway and the caller would have seen a false failure. (The shell's
        // own 10s long-lived-MCP CALL_TIMEOUT can still drop OUR caller first;
        // a retry then hits the recorded grant with no prompt.)
        const r = await callSidecar(
          sidecar,
          'project.open',
          { path: args.path },
          EXTERNAL_CALL_TIMEOUT_MS,
        );
        if (r.ok) {
          const rec = r as unknown as { projectId?: string; project?: unknown };
          if (typeof rec.projectId === 'string') {
            registry.set(rec.projectId, {
              path: args.path as string,
              project: rec.project,
            });
          }
        }
        return r;
      },
    },
    {
      name: 'project.close',
      description: 'Close an open project; releases its FS watcher + LRU entries.',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string' } },
        required: ['projectId'],
        additionalProperties: false,
      },
      async handler(args) {
        const r = await callSidecar(sidecar, 'project.close', { projectId: args.projectId });
        if (r.ok) registry.delete(args.projectId as string);
        return r;
      },
    },
    {
      name: 'project.list',
      description: 'List previously-opened projects (most recent first).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async handler() {
        return callSidecar(sidecar, 'project.list', undefined);
      },
    },
    {
      name: 'project.recents',
      description:
        'List previously-opened projects (most recent first), enriched with ' +
        'archetype_id/cell_count/aspect recorded at open time. Projects whose ' +
        'path no longer resolves on disk are filtered out (contrast with ' +
        'project.list, which keeps them and flags exists:false).',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Cap on returned entries (default 20).' },
        },
        additionalProperties: false,
      },
      async handler(args) {
        return callSidecar(sidecar, 'project.recents', { limit: args.limit });
      },
    },
    {
      name: 'project.create',
      description:
        'Scaffold a new project on disk from an archetype id, then open it. '
        + 'Runs the same WP-04 per-folder trust gate as project.open before '
        + 'touching the filesystem, so an ungranted path pops a native prompt.',
      inputSchema: {
        type: 'object',
        properties: {
          archetype_id: { type: 'string' },
          path: { type: 'string', description: 'Project root directory to create.' },
          name: { type: 'string', description: 'Human-readable project title.' },
        },
        required: ['archetype_id', 'path', 'name'],
        additionalProperties: false,
      },
      async handler(args) {
        // Same trust-gate timeout rationale as project.open above.
        const r = await callSidecar(
          sidecar,
          'project.create',
          {
            archetype_id: args.archetype_id,
            path: args.path,
            name: args.name,
          },
          EXTERNAL_CALL_TIMEOUT_MS,
        );
        if (r.ok) {
          const rec = r as unknown as { projectId?: string; project?: unknown };
          if (typeof rec.projectId === 'string') {
            registry.set(rec.projectId, {
              path: args.path as string,
              project: rec.project,
            });
          }
        }
        return r;
      },
    },
    {
      name: 'project.info',
      description: 'Fetch live project info: parsed Project + LRU openCells + queueDepth.',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string' } },
        required: ['projectId'],
        additionalProperties: false,
      },
      async handler(args) {
        return callSidecar(sidecar, 'project.info', { projectId: args.projectId });
      },
    },
  ];
}
