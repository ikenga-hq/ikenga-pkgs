// Types for the parts of check.mjs the unit tests use (scripts/check-view/*.test.ts).

export declare const CHECKER: string;
/** The canonical decision writer (decision-writer.js, LF, trimmed). */
export declare const WRITER: string;
/** Its version, e.g. "v2". */
export declare const WRITER_VERSION: string;
/** What is wrong with the decision writer a page inlines, or null (rule `stale-writer`). */
export declare function staleWriter(html: string): string | null;
/** The page with the project block replaced by `project` (every "<" written as <); undefined when it has no good block. */
export declare function injectProject(html: string, project: unknown): string | undefined;
