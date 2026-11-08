// Types for predicates.mjs (shared by check-view and hosts/shared.ts).

export declare function viewManifest(html: string): Record<string, unknown> | undefined;
export declare function viewIdOf(html: string): string | undefined;
export declare function decisionWriteSigns(html: string): string[];
