#!/usr/bin/env bash
set -euo pipefail

# drizzle-kit on an exFAT volume
#
# This repo lives on an exFAT external disk. macOS cannot store extended
# attributes there, so it writes an AppleDouble sibling for every file —
# `_journal.json` gets a `.__journal.json` next to it. drizzle-kit globs
# `meta/*.json`, tries to JSON.parse that sibling, and the command dies.
#
# Cleaning first does not help: drizzle-kit creates the file during its own run.
# Pointing `out` at an absolute path outside the volume does not work either —
# drizzle-kit prefixes `./`, so `/var/folders/...` becomes `.//var/folders/...`.
#
# So the output path stays relative and is a symlink into the system disk, which
# is APFS. drizzle-kit writes through it, no siblings are created, and the result
# is copied back into the repo.

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${TMPDIR:-/tmp}/obizee-erp-drizzle"
LINK=".drizzle-work"

cd "$REPO_DIR"
rm -rf "$WORK_DIR" "$LINK"
mkdir -p "$WORK_DIR"

if [ -d drizzle ]; then
  rsync -a --exclude '._*' drizzle/ "$WORK_DIR/"
fi

ln -s "$WORK_DIR" "$LINK"
trap 'rm -f "$REPO_DIR/$LINK"' EXIT

DRIZZLE_OUT="$LINK" npx drizzle-kit generate "$@"

mkdir -p drizzle
rsync -a --delete --exclude '._*' "$WORK_DIR/" drizzle/
find drizzle -name '._*' -delete 2>/dev/null || true

echo "Generated into $REPO_DIR/drizzle"
