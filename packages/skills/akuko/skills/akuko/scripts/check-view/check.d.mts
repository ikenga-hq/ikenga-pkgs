// Types for the parts of check.mjs the unit tests use (scripts/check-view/*.test.ts).

export declare const CHECKER: string;
/** The canonical decision writer (decision-writer.js, LF, trimmed). */
export declare const WRITER: string;
/** Its version, e.g. "v2". */
export declare const WRITER_VERSION: string;
/** What is wrong with the decision writer a page inlines, or null (rule `stale-writer`). */
export declare function staleWriter(html: string): string | null;
