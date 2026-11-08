// Types for harness.mjs (used by scripts/check-view/*.test.ts).

export declare function hiddenReasons(html: string, ids: string[]): Record<string, string | null>;

export interface BridgePost {
  __iyke?: boolean;
  kind?: string;
  payload?: { key?: string; value?: { id: string; action: string; unit: string }[] };
}

export declare function loadWriter(opts: {
  writer: string;
  outbox?: unknown[] | null;
  slug?: string;
  ikenga?: boolean;
}): {
  onLoad: BridgePost[];
  emit(f: { action: string; unit: string; stage: string; text?: string; undoes?: string }): { decision: { id: string }; posts: BridgePost[] };
  close(): void;
};
