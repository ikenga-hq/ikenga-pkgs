/**
 * Adapter registry (WP-03b).
 *
 * The single place the sidecar resolves a renderer adapter by id and the
 * single source of the G2 capability matrix that `render.list_engines`
 * surfaces. WP-05 (hyperframes) + WP-05b (excalidraw) ship the concrete
 * adapters; this module imports them and exposes lookup + engine resolution.
 *
 * G23 — content-path → engine auto-resolution. The order is fixed
 * (`.html → hyperframes`, `.excalidraw → excalidraw`, `.py`/`.blend → blender`,
 * `.tsx → remotion` [rejected as P2], empty → fal, anything else → honest
 * error). This mirrors the MCP-layer RenderShim
 * resolution that WP-06 implemented in-MCP, but now lives at the sidecar
 * enqueue boundary so it is enforced regardless of caller.
 *
 * WP-32 DoD 8 — auto-resolution consent guard. `resolveEngine` alone will
 * still map an extension-less `content_path` to `fal` (see the `case ''`
 * comment below): that mapping is correct in isolation, fal being the only
 * adapter that renders from a prompt with no on-disk content. But `fal` is
 * `requires_network: true` — a metered, vault-keyed network call — and
 * nothing about "auto" should be read as consent to spend money. The actual
 * gate therefore lives one level up, in `resolveEngineWithRequest`'s auto
 * branch: after resolving, it checks the resolved adapter's
 * `capabilities.requires_network` and refuses to return it unless the
 * caller named that engine explicitly (`engine: 'fal'`, not `'auto'`/
 * undefined). This generalizes to any future `requires_network` adapter
 * (Veo/Kling/Runway) with zero changes at this call site.
 */

import { hyperframesAdapter } from './renderers/hyperframes.js';
import { excalidrawAdapter } from './renderers/excalidraw.js';
import { falAdapter } from './renderers/fal.js';
import { blenderAdapter } from './renderers/blender.js';
import { remotionAdapter } from './renderers/remotion.js';
import type { RendererAdapter } from './renderers/types.js';

const ADAPTERS: RendererAdapter[] = [
  hyperframesAdapter,
  excalidrawAdapter,
  falAdapter,
  blenderAdapter,
  remotionAdapter,
];

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
  code:
    | 'engine-not-available-in-p1'
    | 'unresolvable-engine'
    | 'network-engine-requires-explicit-renderer';
  constructor(
    code:
      | 'engine-not-available-in-p1'
      | 'unresolvable-engine'
      | 'network-engine-requires-explicit-renderer',
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
    case 'py':
    case 'blend':
      return 'blender';
    case 'tsx':
      return 'remotion';
    case '':
      // No file-backed content → fal, the network AI generation engine. fal
      // drives from the cell's `prompt` (+ optional anchor image ref), not from
      // on-disk source, so it is the correct *content-path* resolution when
      // there is no .html/.excalidraw content to render. This function does
      // NOT gate on `requires_network` — that consent check lives in
      // `resolveEngineWithRequest`'s auto branch (WP-32 DoD 8), so calling
      // `resolveEngine` directly still returns 'fal' here; an extension-less
      // cell reaching the guarded auto path is rejected there instead.
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
    if (!BY_ID.has(requested)) {
      throw new EngineResolutionError('unresolvable-engine', `unknown engine ${requested}`);
    }
    return requested;
  }
  // Auto path (WP-32 DoD 8 guard). resolveEngine() answers "what does this
  // content_path map to" — it does not know or care whether that engine
  // costs money. A requires_network adapter (fal today; Veo/Kling/Runway
  // later) must never be reached by inference: auto only ever lands on
  // requires_network:false adapters. Reaching a metered engine requires the
  // caller to name it explicitly via `requested`, handled above.
  const id = resolveEngine(contentPath);
  const adapter = BY_ID.get(id);
  if (adapter?.capabilities.requires_network) {
    throw new EngineResolutionError(
      'network-engine-requires-explicit-renderer',
      `content_path resolves to network engine '${id}' (metered); auto will not select a requires_network engine — pass engine:'${id}' explicitly to consent to a paid render`,
    );
  }
  return id;
}
