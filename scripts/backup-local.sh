#!/bin/bash
#
# Back up the database to this machine, and restore it before calling it a
# backup.
#
#   ./scripts/backup-local.sh
#   BACKUP_DIR=/somewhere/else ./scripts/backup-local.sh
#
# **The credential never leaves this laptop.** The first version of this was a
# GitHub Actions workflow, which meant putting `neondb_owner` — the connection
# that can drop every table — into a repository secret, where any third-party
# action in the job can read it and anyone who can push a workflow can print it.
# Common practice; not a good enough reason.
#
# Docker rather than a local Postgres install: `postgres:16` carries both
# `pg_dump` and the throwaway server this restores into, so there is nothing to
# `brew install`, nothing on PATH to drift, and the client version always
# matches the server it is dumping.
#
# Written to the internal disk, not the T7. The drive has already disconnected
# once mid-session, and a backup on the volume you are protecting against is
# not one. At 12 MB a dump, thirty daily and twelve monthly is about 130 MB.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$HOME/obizee-backups}"
IMAGE="postgres:16"
VERIFY="obizee-backup-verify"
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
DUMP="obizee-$STAMP.dump"

say() { printf "\033[2m%s\033[0m %s\n" "·" "$*"; }
die() { printf "\033[31merror\033[0m %s\n" "$*" >&2; exit 1; }

# ---------------------------------------------------------------- the input

[ -f "$HERE/.env" ] || die "no $HERE/.env — nothing to read the connection string from"
# Extracted, not sourced. A Neon connection string ends
# `?sslmode=require&channel_binding=require`, and an unquoted `&` in a sourced
# file is a background operator — bash cuts the value in half and reports the
# variable as unset, which reads as a missing secret rather than a parse
# failure. `cut -d= -f2-` keeps every `=` after the first.
DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "$HERE/.env" | head -1)"
# Strip surrounding quotes if the value carries them, without
# needing any of its own.
DATABASE_URL="${DATABASE_URL%\"}"; DATABASE_URL="${DATABASE_URL#\"}"
[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set in .env"

command -v docker >/dev/null || die "docker is not installed — it provides pg_dump and the restore target"
docker info >/dev/null 2>&1 || die "docker is installed but not running"

mkdir -p "$BACKUP_DIR"

pg() { docker run --rm --network host -e PGCONNECT_TIMEOUT=15 "$IMAGE" "$@"; }

# --------------------------------------------- refuse the wrong connection
#
# `app_runtime` cannot bypass row-level security. Point this at it and every
# policy evaluates false, because no tenant is set — so the dump carries a
# complete schema and zero rows in every tenant table, and restores perfectly.
# Measured: as `app_runtime`, `select count(*) from customers` returns 0 while
# the table holds 8. That is the worst shape a backup can take, because you
# only find out on the day you need it.
ROLE=$(pg psql "$DATABASE_URL" -At -c "select current_user")
BYPASS=$(pg psql "$DATABASE_URL" -At -c "select rolbypassrls from pg_roles where rolname = current_user")
say "connected as $ROLE (bypassrls=$BYPASS)"
[ "$BYPASS" = "t" ] || die "$ROLE cannot see past row-level security — use DATABASE_URL, not APP_DATABASE_URL"

# ------------------------------------------------------------- the dump
#
# Custom format: compressed, and restorable one table at a time when the thing
# that went wrong is one table rather than the database.
say "dumping to $BACKUP_DIR/$DUMP"
docker run --rm --network host -v "$BACKUP_DIR:/out" "$IMAGE" \
  pg_dump --format=custom --no-owner --no-privileges -f "/out/$DUMP" "$DATABASE_URL"

# Counted from the live database *before* the restore, so the comparison is
# against reality rather than against the dump's opinion of itself. `pg_stat` is
# an estimate and is not filtered by row-level security, which is what makes it
# the right source for the check above to be meaningful.
pg psql "$DATABASE_URL" -At -F',' \
  -c "select relname, n_live_tup from pg_stat_user_tables where n_live_tup > 0 order by relname" \
  > "$BACKUP_DIR/manifest-$STAMP.csv"
say "$(wc -l < "$BACKUP_DIR/manifest-$STAMP.csv" | tr -d ' ') tables with rows"

# ------------------------------------------------- restore it, or fail loud

cleanup() { docker rm -f "$VERIFY" >/dev/null 2>&1 || true; }
trap cleanup EXIT

cleanup
docker run -d --name "$VERIFY" -e POSTGRES_PASSWORD=verify -e POSTGRES_DB=verify \
  -v "$BACKUP_DIR:/backup:ro" -p 55432:5432 "$IMAGE" >/dev/null

say "waiting for the restore target"
for _ in $(seq 60); do
  docker exec "$VERIFY" pg_isready -U postgres -q 2>/dev/null && break
  sleep 1
done
docker exec "$VERIFY" pg_isready -U postgres -q || die "the restore target never came up"

say "restoring"
docker exec -e PGPASSWORD=verify "$VERIFY" \
  pg_restore --no-owner --no-privileges \
  --dbname "postgresql://postgres:verify@localhost:5432/verify" "/backup/$DUMP"

say "comparing row counts"
docker exec -e PGPASSWORD=verify "$VERIFY" psql -q \
  "postgresql://postgres:verify@localhost:5432/verify" -c "analyze" >/dev/null

FAILED=0
while IFS=',' read -r table expected; do
  actual=$(docker exec -e PGPASSWORD=verify "$VERIFY" psql -At \
    "postgresql://postgres:verify@localhost:5432/verify" \
    -c "select count(*) from \"$table\"" 2>/dev/null || echo missing)
  # The live figure is a statistics estimate, so this catches "the table did not
  # come back" rather than a drift of a few rows written during the dump.
  if [ "$actual" = "missing" ]; then
    printf "  \033[31mMISSING\033[0m  %-24s expected ~%s\n" "$table" "$expected"; FAILED=1
  elif [ "$actual" = "0" ] && [ "$expected" != "0" ]; then
    printf "  \033[31mEMPTY\033[0m    %-24s expected ~%s\n" "$table" "$expected"; FAILED=1
  else
    printf "  ok       %-24s %s rows\n" "$table" "$actual"
  fi
done < "$BACKUP_DIR/manifest-$STAMP.csv"
[ "$FAILED" = "0" ] || die "the dump restored but does not hold what the database holds"

# A dump that restores but has drifted from the migrations is a backup you
# cannot deploy against.
MIGRATIONS=$(docker exec -e PGPASSWORD=verify "$VERIFY" psql -At \
  "postgresql://postgres:verify@localhost:5432/verify" \
  -c "select count(*) from _applied_migrations")
say "migrations in the backup: $MIGRATIONS"
[ "$MIGRATIONS" -ge 12 ] || die "only $MIGRATIONS migrations in the dump — the schema is not current"

# ------------------------------------------------------------------ prune
#
# Thirty daily. Monthlies are kept by not being caught here: the first dump of
# each month is renamed out of the daily naming, so the sweep cannot see it.
FIRST_OF_MONTH="$BACKUP_DIR/monthly-$(date -u +%Y-%m).dump"
[ -f "$FIRST_OF_MONTH" ] || cp "$BACKUP_DIR/$DUMP" "$FIRST_OF_MONTH"

# shellcheck disable=SC2012
ls -1t "$BACKUP_DIR"/obizee-*.dump 2>/dev/null | tail -n +31 | while read -r old; do
  say "pruning $(basename "$old")"
  rm -f "$old" "${old/obizee-/manifest-}"
done

SIZE=$(du -h "$BACKUP_DIR/$DUMP" | cut -f1)
printf "\n\033[32m✓\033[0m %s (%s), restored and verified\n" "$DUMP" "$SIZE"
printf "  %s — %s dumps, %s total\n" \
  "$BACKUP_DIR" \
  "$(ls -1 "$BACKUP_DIR"/*.dump 2>/dev/null | wc -l | tr -d ' ')" \
  "$(du -sh "$BACKUP_DIR" | cut -f1)"
