/**
 * Tool registry barrel for the studio MCP server.
 *
 * `buildTools()` returns the flat ToolDef[] in stable order; the MCP
 * adapter at ../index.ts maps it into `setRequestHandler(ListTools…)` and
 * `setRequestHandler(CallTool…)`.
 *
 * WP-03b: the in-memory RenderShim is gone — composition/render forward to
 * the sidecar queue. Every former stub (storyboard / anchor / asset /
 * composition.preview|validate / archetype.instantiate_into_project) now
 * forwards to a real sidecar RPC.
 */

import type { SidecarClient } from '../sidecar-client.js';
import type { Catalog } from '../catalog.js';
import { projectTools } from './project.js';
import { storyboardTools } from './storyboard.js';
import { canvasTools } from './canvas.js';
import { breakdownTools } from './breakdown.js';
import { anchorTools } from './anchor.js';
import { assetTools } from './asset.js';
import { compositionTools } from './composition.js';
import { renderTools } from './render.js';
import { spendTools } from './spend.js';
import { exportTools } from './export.js';
import { blockTools } from './block.js';
import { archetypeTools } from './archetype.js';
import type { OpenProjectRegistry, ToolDef } from './types.js';

export function buildTools(opts: {
  sidecar: SidecarClient;
  catalog: Catalog;
  registry: OpenProjectRegistry;
}): ToolDef[] {
  const { sidecar, catalog, registry } = opts;
  return [
    ...projectTools(sidecar, registry),
    ...storyboardTools(sidecar),
    ...canvasTools(sidecar),
    ...breakdownTools(sidecar),
    ...anchorTools(sidecar),
    ...assetTools(sidecar),
    ...compositionTools(sidecar, registry),
    ...renderTools(sidecar),
    ...spendTools(sidecar),
    ...exportTools(sidecar),
    ...blockTools(catalog, registry),
    ...archetypeTools(catalog, registry, sidecar),
  ];
}

export type { ToolDef, OpenProjectRegistry } from './types.js';
