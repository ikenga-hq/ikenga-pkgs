/**
 * Adapter registry (WP-03b).
 *
 * The single place the sidecar resolves a renderer adapter by id and the
 * single source of the G2 capability matrix that `render.list_engines`
 * surfaces. WP-05 (hyperframes) + WP-05b (excalidraw) ship the concrete
 * adapters; this module imports them and exposes lookup + engine resolution.
 *
 * G23 — content-path → engine auto-resolution. The order is fixed
 * (`.html → hyperframes`, `.excalidraw → excalidraw`, `.tsx → remotion`
 * [rejected as P2], else → fal). This mirrors the MCP-layer RenderShim
 * resolution that WP-06 implemented in-MCP, but now lives at the sidecar
 * enqueue boundary so it is enforced regardless of caller.
 */

import { hyperframesAdapter } from './renderers/hyperframes.js';
import { excalidrawAdapter } from './renderers/excalidraw.js';
import { falAdapter } from './renderers/fal.js';
import { BlenderAdapter } from './renderers/blender.js';
import type { RendererAdapter } from './renderers/types.js';

export const blenderAdapter = new BlenderAdapter();

const ADAPTERS: RendererAdapter[] = [hyperframesAdapter, excalidrawAdapter, falAdapter, blenderAdapter];

const BY_ID = new Map<string, RendererAdapter>(ADAPTERS.map((a) => [a.id, a]));

export function getAdapter(id: string): RendererAdapter | undefined {
  return BY_ID.get(id);
}

export interface EngineDescriptor {
  id: string;
  capabilities: RendererAdapter['capabilities'];
}

/**
 * The real G2 matrix, sourced from each adapter's own `.capabilities`. This
 * is what `render.list_engines` returns — it replaces WP-06's hardcoded
 * `P1_ENGINE_CAPABILITIES` array (the response shape is identical so the
 * MCP swap is transparent).
 */
export function listEngines(): EngineDescriptor[] {
  return ADAPTERS.map((a) => ({ id: a.id, capabilities: a.capabilities }));
}

/** Error thrown by `resolveEngine` when no adapter matches the content path. */
export class EngineResolutionError extends Error {
  code: 'engine-not-available-in-p1' | 'unresolvable-engine';
  constructor(
    code: 'engine-not-available-in-p1' | 'unresolvable-engine',
    message: string,
  ) {
    super(message);
    this.name = 'EngineResolutionError';
    this.code = code;
  }
}

function extOf(contentPath: string): string {
  return contentPath.toLowerCase().match(/\.([^./\\]+)$/)?.[1] ?? '';
}

/**
 * G23 — resolve a concrete engine id from a cell's `content_path`. Throws an
 * `EngineResolutionError` (honest domain error) for `.tsx` (Remotion is P2)
 * and for unknown extensions.
 */
export function resolveEngine(contentPath: string): string {
  const ext = extOf(contentPath);
  switch (ext) {
    case 'html':
      return 'hyperframes';
    case 'excalidraw':
      return 'excalidraw';
    case 'blend':
      return 'blender';
    case 'tsx':
      throw new EngineResolutionError('engine-not-available-in-p1', 'remotion is P2');
    case '':
      // No file-backed content → fal, the network AI generation engine. fal
      // drives from the cell's `prompt` (+ optional anchor image ref), not from
      // on-disk source, so it is the correct resolution when there is no
      // .html/.excalidraw content to render.
      return 'fal';
    default:
      // An UNRECOGNIZED extension is NOT silently routed to fal — that would
      // send a mistyped/unexpected content path (e.g. a stray .htm or .json)
      // to the paid network engine with no signal. Fail honestly instead; a
      // caller who wants fal on such a cell passes an explicit renderer.
      throw new EngineResolutionError(
        'unresolvable-engine',
        `no adapter for .${ext} content (expected .html/.excalidraw, or empty for fal); set an explicit renderer to override`,
      );
  }
}

/**
 * Resolve a possibly-explicit engine pick + content path into a concrete
 * engine id, honoring `auto`/undefined → G23 auto-resolution. Returns the
 * concrete id or throws `EngineResolutionError`.
 */
export function resolveEngineWithRequest(
  contentPath: string,
  requested: string | undefined,
): string {
  if (requested && requested !== 'auto') {
    if (requested === 'remotion') {
      throw new EngineResolutionError('engine-not-available-in-p1', 'remotion is P2');
    }
    if (!BY_ID.has(requested)) {
      throw new EngineResolutionError('unresolvable-engine', `unknown engine ${requested}`);
    }
    return requested;
  }
  return resolveEngine(contentPath);
}
