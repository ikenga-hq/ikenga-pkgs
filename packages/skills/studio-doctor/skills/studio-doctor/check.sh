#!/usr/bin/env bash
# studio-doctor preflight. Required deps fail (exit 1); optional deps warn (exit 0).
#
# Portable across Linux / macOS / Windows (Git Bash, MSYS). Chromium is found the
# way the Studio sidecar finds it: an explicit executable path, a system browser,
# or Puppeteer's cache (~/.cache/puppeteer). On Windows the HyperFrames CLI drives
# chrome-headless-shell rather than full Chrome, so that build is required there
# and merely reported elsewhere.
set -u

req_missing=0

check_required() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf '  %-22s ok\n' "$name"
  else
    printf '  %-22s MISSING (required)\n' "$name"
    req_missing=1
  fi
}

check_optional() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf '  %-22s ok\n' "$name"
  else
    printf '  %-22s MISSING (optional)\n' "$name"
  fi
}

is_windows() {
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
  esac
  [ -n "${OS:-}" ] && [ "${OS:-}" = "Windows_NT" ]
}

puppeteer_cache_dir() {
  if [ -n "${PUPPETEER_CACHE_DIR:-}" ]; then printf '%s' "$PUPPETEER_CACHE_DIR"; return; fi
  local home="${HOME:-}"
  if [ -z "$home" ] && [ -n "${USERPROFILE:-}" ]; then home="$USERPROFILE"; fi
  printf '%s/.cache/puppeteer' "$home"
}

# Any executable under <cache>/<kind>/<platform>-<build>/<folder>/ — the layout
# @puppeteer/browsers writes. Matches chrome, chrome.exe and the mac app bundle.
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
  [ -n "${PUPPETEER_EXECUTABLE_PATH:-}" ] && [ -x "${PUPPETEER_EXECUTABLE_PATH}" ] && return 0
  command -v chromium >/dev/null 2>&1 && return 0
  command -v chromium-browser >/dev/null 2>&1 && return 0
  command -v google-chrome >/dev/null 2>&1 && return 0
  command -v google-chrome-stable >/dev/null 2>&1 && return 0
  [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] && return 0
  [ -x "${PROGRAMFILES:-/c/Program Files}/Google/Chrome/Application/chrome.exe" ] && return 0
  puppeteer_has chrome
}

headless_shell_present() {
  [ -n "${HYPERFRAMES_BROWSER_PATH:-}" ] && [ -x "${HYPERFRAMES_BROWSER_PATH}" ] && return 0
  puppeteer_has chrome-headless-shell
}

# The interpreter that actually runs studio-beat-detect: first of python3 /
# python / py that starts and reports 3.x. (On Windows `python3` is often the
# Microsoft Store alias stub, so probing the name alone is not enough.)
PY_BIN=""
for cand in python3 python py; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)' >/dev/null 2>&1; then
    PY_BIN="$cand"; break
  fi
done
python_present() { [ -n "$PY_BIN" ]; }
librosa_present() { [ -n "$PY_BIN" ] && "$PY_BIN" -c 'import librosa' >/dev/null 2>&1; }

echo "studio-doctor — toolchain preflight"
echo "required:"
check_required "ffmpeg"   command -v ffmpeg
check_required "chromium" chromium_present
if is_windows; then
  check_required "chrome-headless-shell" headless_shell_present
fi
check_required "bun"      command -v bun
echo "optional (music-video / studio-beat-detect):"
check_optional "python3"  python_present
check_optional "librosa"  librosa_present
if ! is_windows; then
  check_optional "chrome-headless-shell" headless_shell_present
fi

echo "---"
if [ "$req_missing" -ne 0 ]; then
  echo "summary: a REQUIRED dependency is missing — fix before building."
  if is_windows && ! headless_shell_present; then
    echo "hint: HyperFrames on Windows needs the headless shell: npx puppeteer browsers install chrome-headless-shell"
  fi
  exit 1
fi
echo "summary: all required deps present (optional warnings, if any, are safe to ignore unless building music videos)."
exit 0
