// Types for hidden.mjs (used by scripts/check-view/*.test.ts).

export declare function cssPx(value: unknown): number | null;
export declare function substituteVars(value: unknown, lookup: (name: string) => string | null | undefined, depth?: number): string;
export declare function cssVars(text: string): Map<string, string[]>;
export declare function smallText(css: string, rest: string, html: string): string[];
export declare function hiddenReason(w: unknown, el: unknown): string | null;
