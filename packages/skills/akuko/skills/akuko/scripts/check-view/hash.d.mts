// Types for hash.mjs (the conformance hash, views/contract.md §8).

export declare const PROJECT_BLOCK: string;
export declare const DATA_BLOCKS: string[];
export declare const blankComments: (html: string) => string;
export declare function findJsonBlock(html: string, id: string, opts?: { json?: boolean }): { status: 'none' } | { status: 'bad'; reason: string } | { status: 'ok'; start: number; end: number };
export declare function conformanceText(html: string): string;
export declare function conformanceHash(html: string): string;
