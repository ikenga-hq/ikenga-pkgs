#!/usr/bin/env bash
# Build the com.ikenga.studio project sidecar as a node-runnable ESM bundle
# with a #!/usr/bin/env node shebang.
#
# DO NOT use `bun --compile` (Round 8 / G18, see plans/studio/08-tsserver-stdin-eof-bug.md):
#  - compiled bun sets process.execPath to the bundle, so spawn('node', …)
#    and spawn('ffmpeg', …) cannot resolve the system binary;
#  - piped-stdin handling is flaky under compiled bun, and this sidecar
#    reads JSON-RPC frames from stdin, so frames would silently drop.

set -euo pipefail

cd "$(dirname "$0")"

mkdir -p dist
OUTPUT="dist/sidecar.js"
TMP="dist/.sidecar.tmp.js"

WATCH_FLAG=""
if [[ "${1:-}" == "--watch" ]]; then
  WATCH_FLAG="--watch"
fi

# `--external better-sqlite3`: db.ts's Node-only FALLBACK branch imports it, but
# it is deliberately NOT a declared dep since the Bun migration (7e068a6) —
# bun:sqlite is the real driver. Without the flag the bundler tries to resolve
# it anyway and the whole build fails, so the sidecar could not be rebuilt at
# all. External for exactly the reason db.ts carries a @ts-ignore there.
echo "==> bundling $OUTPUT (target: bun, format: esm)"
bun build $WATCH_FLAG \
  --target=bun \
  --format=esm \
  --external chokidar \
  --external esbuild \
  --external better-sqlite3 \
  src/index.ts \
  --outfile "$TMP"

# Prepend shebang — bun build doesn't add one for plain ESM outputs.
{
  echo '#!/usr/bin/env bun'
  cat "$TMP"
} > "$OUTPUT"
chmod +x "$OUTPUT"
rm "$TMP"

echo "==> done: $(du -h "$OUTPUT" | cut -f1) $OUTPUT"
