#!/usr/bin/env bash
# akuko doctor: toolchain preflight, then provider-key / config / project checks.
#
# Usage: scripts/doctor.sh [project-dir]
#
# Lifted from studio-doctor/check.sh. Required deps fail (exit 1); optional deps
# warn (exit 0). What is required: Node 22.6+ (akuko's scripts run TypeScript
# directly). Everything for rendering (FFmpeg, HyperFrames, a headless browser)
# is optional: storyboards, prompt packages and the review board work without
# them, and each is only needed from the stage that renders.
#
# Portable across Linux / macOS / Windows (Git Bash, MSYS).
#
# Test hooks (never set these in real use):
#   AKUKO_DOCTOR_HIDE="ffmpeg,hyperframes"  treat the named tools as not installed
#   AKUKO_DOCTOR_MIN_NODE=22.6              minimum Node version (raise it to force a required failure)
set -u

req_missing=0
HIDE=",${AKUKO_DOCTOR_HIDE:-},"
MIN_NODE="${AKUKO_DOCTOR_MIN_NODE:-22.6}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="${1:-$PWD}"

hidden() { case "$HIDE" in *",$1,"*) return 0 ;; esac; return 1; }
have() { hidden "$1" && return 1; command -v "$1" >/dev/null 2>&1; }

check_required() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf '  %-24s ok\n' "$name"
  else
    printf '  %-24s MISSING (required)\n' "$name"
    req_missing=1
  fi
}

check_optional() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf '  %-24s ok\n' "$name"
  else
    printf '  %-24s MISSING (optional)\n' "$name"
  fi
}

is_windows() {
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
  esac
  [ "${OS:-}" = "Windows_NT" ]
}

node_ok() {
  have node || return 1
  local v major minor
  v="$(node -p 'process.versions.node' 2>/dev/null)" || return 1
  major="${v%%.*}"; minor="${v#*.}"; minor="${minor%%.*}"
  local need_major="${MIN_NODE%%.*}" need_minor="${MIN_NODE#*.}"
  [ "$major" -gt "$need_major" ] && return 0
  [ "$major" -eq "$need_major" ] && [ "$minor" -ge "$need_minor" ]
}

puppeteer_cache_dir() {
  if [ -n "${PUPPETEER_CACHE_DIR:-}" ]; then printf '%s' "$PUPPETEER_CACHE_DIR"; return; fi
  local home="${HOME:-}"
  if [ -z "$home" ] && [ -n "${USERPROFILE:-}" ]; then home="$USERPROFILE"; fi
  printf '%s/.cache/puppeteer' "$home"
}

puppeteer_has() {
  local kind="$1" dir
  dir="$(puppeteer_cache_dir)/$kind"
  [ -d "$dir" ] || return 1
  find "$dir" -mindepth 3 -maxdepth 5 -type f \
    \( -name 'chrome' -o -name 'chrome.exe' -o -name 'chrome-headless-shell' \
       -o -name 'chrome-headless-shell.exe' -o -name 'Google Chrome for Testing' \) \
    2>/dev/null | grep -q .
}

chromium_present() {
  hidden browser && return 1
  [ -n "${PUPPETEER_EXECUTABLE_PATH:-}" ] && [ -x "${PUPPETEER_EXECUTABLE_PATH}" ] && return 0
  command -v chromium >/dev/null 2>&1 && return 0
  command -v chromium-browser >/dev/null 2>&1 && return 0
  command -v google-chrome >/dev/null 2>&1 && return 0
  command -v google-chrome-stable >/dev/null 2>&1 && return 0
  [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] && return 0
  [ -x "${PROGRAMFILES:-/c/Program Files}/Google/Chrome/Application/chrome.exe" ] && return 0
  puppeteer_has chrome
}

# Windows: HyperFrames' bundled headless shell can crash on launch (R-9), so
# HYPERFRAMES_BROWSER_PATH must point at a working Chrome. Reported only; we
# never set it for the person (`/akuko setup` prints the instructions).
browser_path_ok() {
  hidden browser_path && return 1
  [ -n "${HYPERFRAMES_BROWSER_PATH:-}" ] && [ -f "${HYPERFRAMES_BROWSER_PATH}" ]
}

echo "akuko doctor — toolchain preflight"
echo "required:"
check_required "node >= $MIN_NODE" node_ok
echo "optional (needed from the stage that renders):"
check_optional "ffmpeg" have ffmpeg
check_optional "hyperframes" have hyperframes
check_optional "chrome / chromium" chromium_present
if is_windows; then
  check_optional "HYPERFRAMES_BROWSER_PATH" browser_path_ok
fi

echo "---"
if is_windows && ! browser_path_ok; then
  echo "hint: on Windows set HYPERFRAMES_BROWSER_PATH to your Chrome executable, e.g. in PowerShell:"
  echo "      setx HYPERFRAMES_BROWSER_PATH \"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\""
  echo "      (doctor never changes your environment; \`/akuko setup\` shows the same steps)"
fi

# Runtime packages first, without importing them: an installed skill has no node_modules,
# and every TypeScript step below would crash with "Cannot find package 'zod'".
deps_ok=0
if node_ok; then
  echo "runtime dependencies:"
  node "$SKILL_DIR/scripts/doctor/deps.mjs" | sed 's/^/  /'
  deps_ok=${PIPESTATUS[0]}
  if [ "$deps_ok" -ne 0 ]; then req_missing=1; fi
fi

if node_ok && [ "$deps_ok" -ne 0 ]; then
  echo "provider and project checks skipped: install the runtime packages above, then run doctor again."
elif node_ok; then
  node --experimental-strip-types --disable-warning=ExperimentalWarning \
    "$SKILL_DIR/scripts/doctor/cli.ts" "$PROJECT_DIR"
  cli_status=$?
  if [ "$cli_status" -ne 0 ]; then req_missing=1; fi
else
  echo "provider and project checks skipped: they need Node $MIN_NODE or newer."
fi

echo "---"
if [ "$req_missing" -ne 0 ]; then
  echo "summary: a REQUIRED check failed — fix before building."
  exit 1
fi
echo "summary: all required deps present (optional warnings, if any, are safe to ignore until you render)."
exit 0
