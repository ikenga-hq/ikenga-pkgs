/**
 * akuko — host adapter contract (gate G-HOST).
 *
 * One shape every host implements: A claude-artifact (claude.ai), B local
 * (Claude Code), C ikenga (the Ikenga shell, optionally with Studio). Every
 * action calls `detect()` first, then reads and writes the project only
 * through the adapter, so actions stay host-agnostic.
 *
 * Shape is fixed by the plan (01 §Schema / contract). WP-03 codes against the
 * wave-1 subset `WaveOneHost` (mock contract 4); do not change these method
 * signatures without a plan decision.
 *
 * What each host can actually do is recorded in `lib/hosts.md`
 * §Host-capability note (G-09).
 */

import type { AkukoProject, Asset, AssetKind, Decision } from '../schema/akuko-project.ts';

/** A claude-artifact · B local (Claude Code) · C ikenga. */
export type HostLevel = 'A' | 'B' | 'C';

export interface Capabilities {
  /** Can run shell commands somewhere (on host A: claude.ai's cloud workspace, not the user's machine). */
  shell: boolean;
  /** DURABLE read/write access to the project folder. False on host A, whose workspace is remote and lasts one chat. */
  fs: boolean;
  /** A Claude artifact database is reachable (claude.ai `db` capability, or the ArtifactData tool). */
  artifactDb: boolean;
  /** A running Ikenga shell is reachable (iyke bridge / `window.__ikenga_host__`). */
  ikengaBridge: boolean;
  /** The Studio MCP server is connected. */
  studioMcp: boolean;
  /** The agent can execute code (true on A, B and C; false only for a runtime with no code tool at all). */
  codeExec: boolean;
  /** Names of connected MCP servers / connectors, e.g. `['canva', 'studio']`. */
  connectedMcps: string[];
}

/** A file to store. Bytes never go into `akuko.json`; the host returns an `Asset` that points at them. */
export interface AssetInput {
  kind: AssetKind;
  filename: string;        // suggested basename, e.g. 'sc1_sh2-keyframe.png'
  mime: string;
  data: Uint8Array;        // bytes; never written into akuko.json
  id?: string;             // host assigns one if absent
  owner?: string; name?: string; provider?: string; model?: string; tags?: string[];
}

/**
 * A review surface or freehand view to publish.
 * PROVISIONAL — WP-07a (view contract, G-VIEW) refines this shape.
 */
export interface ViewArtifact {
  /** Stable view name, e.g. 'default-board' or 'freehand-cast-sheet'. Used as the file / artifact name. */
  name: string;
  /** Complete HTML document. */
  html: string;
  /** Human title; defaults to `name`. */
  title?: string;
  /** True when the view writes decisions (must pass the conformance check first — WP-07a). */
  writesDecisions?: boolean;
}

export interface HostAdapter {
  detect(): Promise<{ level: HostLevel; capabilities: Capabilities }>;
  readState(): Promise<AkukoProject>;
  writeState(p: AkukoProject): Promise<void>;           // never called by a view
  storeAsset(a: AssetInput): Promise<Asset>;            // files locally, asset store on A, bridge on C
  publishView(v: ViewArtifact): Promise<{ url?: string; path?: string }>;
  readDecisions(since?: string): Promise<Decision[]>;   // delegates to decisions/<store>.ts (WP-07a)
}

/** The wave-1 subset WP-03 codes against (mock contract 4). */
export type WaveOneHost = Pick<HostAdapter, 'readState' | 'writeState' | 'storeAsset'>;
