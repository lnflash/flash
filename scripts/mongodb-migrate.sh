#!/bin/sh
#
# Runs on every helm release, and EVERY Mongo-touching workload waits on it via
# the `wait-for-mongodb-migrate` initContainer. That gate is only worth
# anything if this script can fail — so it does.
#
# It did not, until 2026-08-26. `migrate-mongo up` aborts the whole run on the
# first migration that throws, and with no `set -e` and a trailing `status`
# (which always succeeds) the Job exited 0 regardless. Prod applied no
# migration for five months while every deploy reported success, and the
# breakage only surfaced when an api pod crash-looped building a unique index
# whose dedupe migration had never run. See ENG-565.
set -eu

CONFIG=src/migrations/migrate-mongo-config.js
MIGRATE=node_modules/.bin/migrate-mongo

echo "=== migrations before ==="
"$MIGRATE" status -f "$CONFIG"

echo "=== applying ==="
# `set -e` already aborts here on a non-zero exit, which is the common failure
# (a migration throwing). Belt and braces below for the case where migrate-mongo
# reports success while leaving work undone.
"$MIGRATE" up -f "$CONFIG"

echo "=== migrations after ==="
STATUS_AFTER=$("$MIGRATE" status -f "$CONFIG")
echo "$STATUS_AFTER"

# A green run that applied nothing is indistinguishable from a real one unless
# we look. Anything still PENDING here means the DB is not at the schema this
# release expects, and admitting pods against it is how the index-build
# crash-loop happened.
if echo "$STATUS_AFTER" | grep -q "PENDING"; then
  echo "ERROR: migrations still PENDING after 'up' — refusing to report success." >&2
  echo "Pods gate on this Job; letting it pass would start them against an unmigrated database." >&2
  exit 1
fi

echo "All migrations applied."
