#!/usr/bin/env bash
set -euo pipefail

# drizzle-kit on an exFAT volume
#
# This repo lives on an exFAT external disk. macOS cannot store extended
# attributes there, so it writes an AppleDouble sibling for every file —
# `_journal.json` gets a `.__journal.json` next to it. drizzle-kit globs
# `meta/*.json` and tries to JSON.parse that sibling, which is binary, and the
# whole command dies with "Unexpected token ' '".
#
# Cleaning beforehand does not help: drizzle-kit creates the file during its own
# run. So generation happens on the system disk, which is APFS, and the result
# is copied back without the siblings.

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${TMPDIR:-/tmp}/obizee-erp-drizzle"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

if [ -d "$REPO_DIR/drizzle" ]; then
  rsync -a --exclude '._*' "$REPO_DIR/drizzle/" "$WORK_DIR/"
fi

cd "$REPO_DIR"
DRIZZLE_OUT="$WORK_DIR" npx drizzle-kit generate "$@"

rsync -a --delete --exclude '._*' "$WORK_DIR/" "$REPO_DIR/drizzle/"
find "$REPO_DIR/drizzle" -name '._*' -delete 2>/dev/null || true

echo "Generated into $REPO_DIR/drizzle"
