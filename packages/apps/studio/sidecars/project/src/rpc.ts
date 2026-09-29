/**
 * JSON-RPC 2.0 over stdio — line-delimited (one JSON object per line).
 *
 * The sidecar reads requests from stdin and writes responses on stdout.
 * Notifications (no `id`) are emitted by ./events.ts; the watcher path
 * doesn't pass through this dispatcher.
 *
 * Logs always go to stderr (never stdout).
 */

import { createInterface, type Interface } from 'node:readline';
import { z } from 'zod';

import {
  ProjectSchema,
  type Project,
} from '@ikenga/studio-schema';

import type {
  ErrorCode,
  GenericResult,
  ProjectCloseParams,
  ProjectCreateParams,
  ProjectInfoParams,
  ProjectInfoResult,
  ProjectLastOpenParams,
  ProjectLastOpenResult,
  ProjectListResult,
  ProjectOpenParams,
  ProjectOpenResult,
  ProjectRecentsParams,
  ProjectRecentsResult,
  ProjectSummary,
  RpcMethod,
} from './rpc-types.js';

// ─────────────────────────────────────────────────────────────────────────
// JSON-RPC framing
// ─────────────────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export function writeResponse(resp: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(resp) + '\n');
}

export function logErr(msg: string): void {
  process.stderr.write(`[studio-sidecar] ${msg}\n`);
}

// ─────────────────────────────────────────────────────────────────────────
// Handler interface (impl lives in index.ts)
// ─────────────────────────────────────────────────────────────────────────

export interface RpcHandlers {
  open(params: ProjectOpenParams): Promise<ProjectOpenResult>;
  close(params: ProjectCloseParams): Promise<{ ok: true } | { ok: false; error: ErrorCode; message?: string }>;
  list(): Promise<ProjectListResult>;
  /**
   * G-47 — enriched recents registry (archetypeId/cellCount/aspect, dead
   * paths filtered out). Distinct from `list`: see rpc-types.ts.
   */
  recents(params: ProjectRecentsParams): Promise<ProjectRecentsResult>;
  /**
   * G-50 — persisted open-project state, so a respawned sidecar can offer the
   * reopen. Read-only: it mounts nothing, and the caller's reopen still goes
   * through `project.open` and the WP-04 trust gate.
   */
  lastOpen(params: ProjectLastOpenParams): Promise<ProjectLastOpenResult>;
  create(params: ProjectCreateParams): Promise<ProjectOpenResult>;
  info(params: ProjectInfoParams): Promise<ProjectInfoResult>;
  /**
   * Catch-all for the WP-03b method surface (storyboard / anchor / asset /
   * composition / archetype / render). The handler owns its own per-method
   * param validation and returns an `{ ok, ... }` envelope written straight
   * onto the JSON-RPC result.
   */
  extended(method: RpcMethod, params: unknown): Promise<GenericResult>;
}

// ─────────────────────────────────────────────────────────────────────────
// Param schemas (re-validation on input)
// ─────────────────────────────────────────────────────────────────────────

const OpenParamsSchema = z.object({ path: z.string().min(1) });
const CloseParamsSchema = z.object({ projectId: z.string().min(1) });
const CreateParamsSchema = z.object({
  archetype_id: z.string().min(1),
  path: z.string().min(1),
  name: z.string().min(1),
});
const InfoParamsSchema = z.object({ projectId: z.string().min(1) });
const RecentsParamsSchema = z.object({
  limit: z.number().int().positive().max(200).optional(),
});
const LastOpenParamsSchema = z.object({
  limit: z.number().int().positive().max(200).optional(),
  openOnly: z.boolean().optional(),
});

// ─────────────────────────────────────────────────────────────────────────
// Project shape validation (used by handlers when hydrating from disk)
// ─────────────────────────────────────────────────────────────────────────

export function validateProject(input: unknown): Project {
  return ProjectSchema.parse(input);
}

// ─────────────────────────────────────────────────────────────────────────
// Dispatch loop
// ─────────────────────────────────────────────────────────────────────────

function invalidParams(id: number | string | null, message: string): void {
  writeResponse({
    jsonrpc: '2.0',
    id,
    error: { code: -32602, message: `invalid params: ${message}` },
  });
}

function methodNotFound(id: number | string | null, method: string): void {
  writeResponse({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `method not found: ${method}` },
  });
}

function parseError(): void {
  writeResponse({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32700, message: 'parse error' },
  });
}

/** WP-03b method names routed to `handlers.extended`. */
const EXTENDED_METHODS = new Set<string>([
  'storyboard.read',
  'storyboard.read_cell',
  'storyboard.read_fountain',
  'storyboard.write_fountain',
  'storyboard.write_cell',
  'storyboard.read_cell_content',
  'storyboard.write_cell_content',
  'storyboard.create_cell',
  'storyboard.delete_cell',
  'storyboard.list_cells',
  'storyboard.upsert_beat',
  'storyboard.upsert_rung',
  'storyboard.set_approved',
  // Plan 25 / D-25-5 — reordering WITHIN the sequence lane is the only canvas
  // gesture allowed to mutate `Cell.index`; free placement never reaches here.
  'storyboard.reorder_cells',
  // Plan 25 / G-76 — authored canvas layout persisted to
  // <projectRoot>/.studio/canvas.json (NOT localStorage, NOT storyboard.json).
  'canvas.read',
  'canvas.write',
  'breakdown.run',
  'anchor.list',
  'anchor.create',
  'anchor.generate',
  'anchor.delete',
  'asset.list',
  'asset.import',
  'asset.resolve',
  'composition.preview',
  'composition.validate',
  'archetype.instantiate_into_project',
  'render.enqueue',
  'render.status',
  'render.cancel',
  'render.list',
  'render.list_engines',
  'render.read_bytes',
  'render.read_poster',
  'render.list_posters',
  'render.ingest_external',
  'spend.status',
  'export.compose',
  'export.status',
  'export.list',
  'export.read_bytes',
  'export.check_bed',
  'export.prompt_package',
  // Plan 24 / WP-23 — DaVinci Resolve & OTIO. G-75 #1: this was implemented
  // in index.ts's `extended()` switch since WP-23 but never registered
  // here, so every call 404'd with -32601 method-not-found over stdio.
  'export.davinci_timeline',
]);

export function startRpcLoop(handlers: RpcHandlers): { close(): void } {
  const rl: Interface = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on('line', async (line: string) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      parseError();
      return;
    }
    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      writeResponse({
        jsonrpc: '2.0',
        id: req.id ?? null,
        error: { code: -32600, message: 'invalid request' },
      });
      return;
    }

    const id = req.id ?? null;
    try {
      switch (req.method as RpcMethod) {
        case 'project.open': {
          const p = OpenParamsSchema.safeParse(req.params);
          if (!p.success) return invalidParams(id, p.error.message);
          writeResponse({ jsonrpc: '2.0', id, result: await handlers.open(p.data) });
          return;
        }
        case 'project.close': {
          const p = CloseParamsSchema.safeParse(req.params);
          if (!p.success) return invalidParams(id, p.error.message);
          writeResponse({ jsonrpc: '2.0', id, result: await handlers.close(p.data) });
          return;
        }
        case 'project.list': {
          writeResponse({ jsonrpc: '2.0', id, result: await handlers.list() });
          return;
        }
        case 'project.recents': {
          // Params are optional in full — `{}`/absent means "defaults".
          const p = RecentsParamsSchema.safeParse(req.params ?? {});
          if (!p.success) return invalidParams(id, p.error.message);
          writeResponse({ jsonrpc: '2.0', id, result: await handlers.recents(p.data) });
          return;
        }
        case 'project.last_open': {
          // Params are optional in full — `{}`/absent means "defaults".
          const p = LastOpenParamsSchema.safeParse(req.params ?? {});
          if (!p.success) return invalidParams(id, p.error.message);
          writeResponse({ jsonrpc: '2.0', id, result: await handlers.lastOpen(p.data) });
          return;
        }
        case 'project.create': {
          const p = CreateParamsSchema.safeParse(req.params);
          if (!p.success) return invalidParams(id, p.error.message);
          writeResponse({ jsonrpc: '2.0', id, result: await handlers.create(p.data) });
          return;
        }
        case 'project.info': {
          const p = InfoParamsSchema.safeParse(req.params);
          if (!p.success) return invalidParams(id, p.error.message);
          writeResponse({ jsonrpc: '2.0', id, result: await handlers.info(p.data) });
          return;
        }
        default: {
          if (EXTENDED_METHODS.has(req.method)) {
            const result = await handlers.extended(req.method as RpcMethod, req.params);
            writeResponse({ jsonrpc: '2.0', id, result });
            return;
          }
          return methodNotFound(id, req.method);
        }
      }
    } catch (err) {
      logErr(`handler threw on ${req.method}: ${(err as Error).message}`);
      writeResponse({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: 'internal error', data: (err as Error).message },
      });
    }
  });

  return {
    close() {
      rl.close();
    },
  };
}

// Helper used by index.ts when building a `ProjectSummary` from a row. The
// `exists` field is computed by the caller (index.ts owns the fs check), so
// this pure mapper returns everything BUT `exists`.
export function toProjectSummary(row: {
  project_id: string;
  path: string;
  name: string;
  last_opened: number;
}): Omit<ProjectSummary, 'exists'> {
  return {
    projectId: row.project_id,
    path: row.path,
    name: row.name,
    lastOpened: row.last_opened,
  };
}
