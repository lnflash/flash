#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

BACKUP_DIR="$SCRIPT_DIR/backups"
mkdir -p "$BACKUP_DIR"

cd "$REPO_ROOT"

FRAPPE_FRONTEND_SERVICE="frappe-frontend"
FRAPPE_BACKEND_SERVICE="frappe-backend"
SITE_NAME="${SITE_NAME:-frontend}"
APP_NAMES="${APP_NAMES:-}"
BACKUP_DIR_IN_CONTAINER="/tmp/backups"

docker compose exec -T "$FRAPPE_FRONTEND_SERVICE" mkdir -p "$BACKUP_DIR_IN_CONTAINER"
docker compose exec -T "$FRAPPE_BACKEND_SERVICE" mkdir -p "$BACKUP_DIR_IN_CONTAINER"

if [ -z "$APP_NAMES" ]; then
  APP_NAMES=$(docker compose exec -T "$FRAPPE_BACKEND_SERVICE" bench --site "$SITE_NAME" list-apps | awk 'NF && $1 !~ /^(frappe|erpnext)$/ {print $1}' | xargs)
fi

# Run the backup inside the container and capture output
BACKUP_OUTPUT=$(docker compose exec -T "$FRAPPE_FRONTEND_SERVICE" bench --site "$SITE_NAME" backup --backup-path "$BACKUP_DIR_IN_CONTAINER")

# Extract the database path from the output line containing "Database:"
BACKUP_FILE=$(echo "$BACKUP_OUTPUT" | awk -F': +' '/Database:/{split($2, parts, /[[:space:]]+/); print parts[1]; exit}')
SITE_CONFIG_FILE=$(echo "$BACKUP_OUTPUT" | awk -F': +' '/Config:|Site Config:/{split($2, parts, /[[:space:]]+/); print parts[1]; exit}' || true)

if [ -z "$BACKUP_FILE" ]; then
  echo "Error: could not find database backup path in bench output"
  echo "$BACKUP_OUTPUT"
  exit 1
fi

BACKUP_FILENAME=$(basename "$BACKUP_FILE")
BACKUP_PREFIX=${BACKUP_FILENAME%-database.sql.gz}
if [ "$BACKUP_PREFIX" = "$BACKUP_FILENAME" ]; then
  BACKUP_PREFIX=${BACKUP_FILENAME%.sql.gz}
fi

BUNDLE_STAGING_DIR=$(mktemp -d "$BACKUP_DIR/full-backup.XXXXXX")
trap 'rm -rf "$BUNDLE_STAGING_DIR"' EXIT

mkdir -p "$BUNDLE_STAGING_DIR/apps"

docker compose cp "$FRAPPE_FRONTEND_SERVICE:$BACKUP_FILE" "$BUNDLE_STAGING_DIR/database.sql.gz"

if [ -n "$SITE_CONFIG_FILE" ]; then
  docker compose cp "$FRAPPE_FRONTEND_SERVICE:$SITE_CONFIG_FILE" "$BUNDLE_STAGING_DIR/site_config_backup.json" || {
    echo "Warning: could not copy site config backup from $SITE_CONFIG_FILE"
  }
fi

BACKED_UP_APPS=""
for APP_NAME in $APP_NAMES; do
  if ! [[ "$APP_NAME" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "Error: invalid app name '$APP_NAME'"
    exit 1
  fi

  APP_ARCHIVE_PATH="$BACKUP_DIR_IN_CONTAINER/$APP_NAME-app.tar.gz"

  docker compose exec -T "$FRAPPE_BACKEND_SERVICE" sh -c '
    app="$1"
    archive_path="$2"
    app_dir="/home/frappe/frappe-bench/apps/$app"

    if [ ! -d "$app_dir" ]; then
      echo "Error: app directory not found: $app_dir" >&2
      exit 1
    fi

    rm -f "$archive_path"
    tar \
      -C /home/frappe/frappe-bench/apps \
      --exclude="$app/.git" \
      --exclude="$app/.worktrees" \
      --exclude="$app/.pytest_cache" \
      --exclude="$app/dev/backups" \
      --exclude="*/__pycache__" \
      --exclude="*.pyc" \
      -czf "$archive_path" "$app"
  ' sh "$APP_NAME" "$APP_ARCHIVE_PATH"

  docker compose cp "$FRAPPE_BACKEND_SERVICE:$APP_ARCHIVE_PATH" "$BUNDLE_STAGING_DIR/apps/$APP_NAME.tar.gz"
  docker compose exec -T "$FRAPPE_BACKEND_SERVICE" rm -f "$APP_ARCHIVE_PATH"

  BACKED_UP_APPS="$BACKED_UP_APPS $APP_NAME"
done

if [ -z "$BACKED_UP_APPS" ]; then
  echo "Warning: no non-core app source archives were included"
fi

cat > "$BUNDLE_STAGING_DIR/manifest.env" <<EOF
BACKUP_FORMAT=flash-frappe-full-backup-v1
SITE_NAME=$SITE_NAME
DATABASE_BACKUP=$BACKUP_FILENAME
APP_NAMES="${BACKED_UP_APPS# }"
CREATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
EOF

BUNDLE_FILE="$BACKUP_DIR/$BACKUP_PREFIX-full-backup.tar.gz"
tar -C "$BUNDLE_STAGING_DIR" -czf "$BUNDLE_FILE" .

echo "Full backup saved to: $BUNDLE_FILE"
echo "Included database: $BACKUP_FILENAME"
echo "Included apps:${BACKED_UP_APPS:- none}"
