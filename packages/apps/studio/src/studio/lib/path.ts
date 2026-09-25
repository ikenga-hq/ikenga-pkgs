// com.ikenga.studio · path helpers
//
// The desktop shell runs on Windows, macOS, and Linux, but a project path
// picked via the native folder dialog arrives at the iframe as a plain
// string with whatever separator the HOST os uses — `\` on Windows,
// `/` elsewhere. `String.prototype.split('/')` silently no-ops on a
// Windows path (no `/` to split on), so a naive "last path segment" derived
// that way returns the WHOLE path rather than the leaf folder name (WP-04
// live round: plans/studio/verify/2026-09-12-wp32-live/wp04/verdict.md
// "Secondary nit" — `Launcher.tsx:245`).

/** Last path segment of `path`, tolerant of both `/` (POSIX) and `\`
 *  (Windows) separators — and of a mix of the two, which Windows itself
 *  tolerates in APIs even though it never produces mixed paths itself.
 *  Trailing separators are ignored (`"C:\\a\\b\\"` → `"b"`, not `""`).
 *  Returns `''` for an empty/separator-only input, and for a bare Windows
 *  drive root (`"C:\\"`, `"C:"`, `"c:/"`) — a drive designator is not a
 *  folder name, and returning `"C:"` would put that string in the UI as a
 *  project title. Callers should fall back to a placeholder name whenever
 *  this returns `''`. */
export function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  if (/^[A-Za-z]:$/.test(trimmed)) return ''; // drive root, no leaf segment
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}
