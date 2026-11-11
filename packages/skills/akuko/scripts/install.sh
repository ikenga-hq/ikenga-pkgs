#!/usr/bin/env bash
#
# akuko — install script (copied to the root of the ikenga-hq/akuko mirror)
#
# Installs the skill into ~/.claude/skills/akuko as a symlink against a cached
# clone in ~/.cache/ikenga-skills/, then runs `npm install` inside the skill
# folder so its TypeScript actions can find zod and @ikenga/studio-schema.
# Update path: re-run this script (or `git -C ~/.cache/ikenga-skills/akuko pull`
# followed by `npm install` in skills/akuko).
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/ikenga-hq/akuko/main/install.sh | bash
#
# Env overrides:
#   SKILLS_DIR    target skills dir (default: $HOME/.claude/skills)
#   CACHE_DIR     clone cache dir   (default: $HOME/.cache/ikenga-skills)
#   REPO_URL      repo to clone     (default: https://github.com/ikenga-hq/akuko.git)
#   REF           git ref to check out (default: main)
#   SKIP_NPM=1    do not run `npm install` (run it yourself later)

set -euo pipefail

SKILL_NAME="akuko"
SKILLS_DIR="${SKILLS_DIR:-$HOME/.claude/skills}"
CACHE_DIR="${CACHE_DIR:-$HOME/.cache/ikenga-skills}"
REPO_URL="${REPO_URL:-https://github.com/ikenga-hq/akuko.git}"
REF="${REF:-main}"

CLONE_DIR="$CACHE_DIR/$SKILL_NAME"
TARGET="$SKILLS_DIR/$SKILL_NAME"
SOURCE="$CLONE_DIR/skills/$SKILL_NAME"

log()  { printf '\033[36m[akuko]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[akuko]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[akuko]\033[0m %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required but not installed."

mkdir -p "$SKILLS_DIR" "$CACHE_DIR"

if [ -d "$CLONE_DIR/.git" ]; then
  log "Updating cached clone at $CLONE_DIR"
  git -C "$CLONE_DIR" fetch --quiet origin "$REF"
  git -C "$CLONE_DIR" checkout --quiet "$REF"
  git -C "$CLONE_DIR" reset --quiet --hard "origin/$REF"
else
  log "Cloning $REPO_URL into $CLONE_DIR"
  git clone --quiet --branch "$REF" --depth 1 "$REPO_URL" "$CLONE_DIR"
fi

[ -d "$SOURCE" ] || die "Skill source not found at $SOURCE (repo layout changed?)."

if [ -L "$TARGET" ]; then
  log "Replacing existing symlink at $TARGET"
  rm "$TARGET"
elif [ -e "$TARGET" ]; then
  BACKUP="$TARGET.bak.$(date +%s)"
  warn "Existing non-symlink at $TARGET — backing up to $BACKUP"
  mv "$TARGET" "$BACKUP"
fi

ln -s "$SOURCE" "$TARGET"
log "Installed: $TARGET -> $SOURCE"

if [ "${SKIP_NPM:-}" = "1" ]; then
  warn "SKIP_NPM=1: run \`npm install\` in $SOURCE before using akuko."
elif command -v npm >/dev/null 2>&1; then
  log "Installing runtime packages (zod, vendored @ikenga/studio-schema; jsdom/ajv optional) in $SOURCE"
  (cd "$SOURCE" && npm install --no-audit --no-fund) || die "npm install failed in $SOURCE"
else
  warn "npm not found: install Node.js 22.6 or newer, then run \`npm install\` in $SOURCE."
fi

log "Check the setup: bash $TARGET/scripts/doctor.sh"
log "Update later: re-run this script."
