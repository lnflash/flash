#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <backup-file.sql.gz|full-backup.tar.gz>"
  echo "Example: $0 backups/20260122_062420-frontend-database.sql.gz"
  echo "Example: $0 backups/20260122_062420-frontend-full-backup.tar.gz"
  exit 1
fi

BACKUP_FILE="$1"
DB_PASSWORD="admin" # defined in docker compose
FRAPPE_BACKEND_SERVICE="frappe-backend"
FRAPPE_FRONTEND_SERVICE="frappe-frontend"
SITE_NAME="${SITE_NAME:-frontend}"
RESTORE_DIR="/tmp/restore"
RESTORE_STAGING_DIR=""

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Error: Backup file '$BACKUP_FILE' not found"
  exit 1
fi

# Get absolute backup path before switching to repo root for docker compose.
BACKUP_FILE=$(cd "$(dirname "$BACKUP_FILE")" && pwd)/$(basename "$BACKUP_FILE")
BACKUP_FILENAME=$(basename "$BACKUP_FILE")

cd "$REPO_ROOT"

cleanup() {
  if [ -n "$RESTORE_STAGING_DIR" ]; then
    rm -rf "$RESTORE_STAGING_DIR"
  fi
}
trap cleanup EXIT

remove_stale_locks() {
  docker compose exec -T "$FRAPPE_BACKEND_SERVICE" rm -f "/home/frappe/frappe-bench/sites/$SITE_NAME/locks/"*.lock 2>/dev/null || true
}

migrate_site() {
  echo "Migrating $SITE_NAME"
  docker compose exec -T "$FRAPPE_BACKEND_SERVICE" bench --site "$SITE_NAME" migrate || {
    echo "Migration failed, retrying..."
    sleep 5
    docker compose exec -T "$FRAPPE_BACKEND_SERVICE" bench --site "$SITE_NAME" migrate
  }
}

restore_database() {
  local database_backup="$1"
  local database_filename

  database_filename=$(basename "$database_backup")

  docker compose exec -T "$FRAPPE_BACKEND_SERVICE" mkdir -p "$RESTORE_DIR"
  docker compose cp "$database_backup" "$FRAPPE_BACKEND_SERVICE:$RESTORE_DIR/$database_filename"

  remove_stale_locks

  docker compose exec -T "$FRAPPE_BACKEND_SERVICE" bench --site "$SITE_NAME" restore --db-root-password "$DB_PASSWORD" "$RESTORE_DIR/$database_filename"
}

restore_app_archive_to_service() {
  local service_name="$1"
  local app_archive="$2"
  local app_archive_filename
  local app_name
  local container_archive

  app_archive_filename=$(basename "$app_archive")
  app_name=${app_archive_filename%.tar.gz}
  container_archive="$RESTORE_DIR/apps/$app_archive_filename"

  docker compose exec -T "$service_name" mkdir -p "$RESTORE_DIR/apps"
  docker compose cp "$app_archive" "$service_name:$container_archive"
  docker compose exec -T --user root "$service_name" chmod 644 "$container_archive"

  docker compose exec -T "$service_name" sh -c '
    app="$1"
    archive_path="$2"
    apps_dir="/home/frappe/frappe-bench/apps"
    previous_apps_dir="/tmp/restore-previous-apps"
    timestamp=$(date -u +"%Y%m%d%H%M%S")

    if tar -tzf "$archive_path" | grep -E "^\.\./|/\.\./|^/|(^|/)\.\.$" >/dev/null; then
      echo "Error: unsafe paths found in $archive_path" >&2
      exit 1
    fi

    if ! tar -tzf "$archive_path" | grep -q "^$app/"; then
      echo "Error: archive $archive_path does not contain top-level app directory $app/" >&2
      exit 1
    fi

    mkdir -p "$previous_apps_dir"
    if [ -d "$apps_dir/$app" ]; then
      mv "$apps_dir/$app" "$previous_apps_dir/$app.$timestamp"
    fi

    tar -C "$apps_dir" -xzf "$archive_path"
  ' sh "$app_name" "$container_archive"
}

restore_app_archive() {
  local app_archive="$1"
  local app_archive_filename
  local app_name

  app_archive_filename=$(basename "$app_archive")
  app_name=${app_archive_filename%.tar.gz}

  if ! [[ "$app_name" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "Error: invalid app archive name '$app_archive_filename'"
    exit 1
  fi

  restore_app_archive_to_service "$FRAPPE_BACKEND_SERVICE" "$app_archive"
  restore_app_archive_to_service "$FRAPPE_FRONTEND_SERVICE" "$app_archive"

  echo "Restored app source: $app_name"
}

is_full_backup_bundle() {
  local tar_list

  tar_list=$(mktemp)
  if tar -tzf "$BACKUP_FILE" > "$tar_list" 2>/dev/null && grep -Eq '(^|^\./)database\.sql\.gz$' "$tar_list"; then
    rm -f "$tar_list"
    return 0
  fi

  rm -f "$tar_list"
  return 1
}

restore_full_backup_bundle() {
  RESTORE_STAGING_DIR=$(mktemp -d)
  tar -xzf "$BACKUP_FILE" -C "$RESTORE_STAGING_DIR"

  if [ ! -f "$RESTORE_STAGING_DIR/database.sql.gz" ]; then
    echo "Error: full backup bundle is missing database.sql.gz"
    exit 1
  fi

  if [ -d "$RESTORE_STAGING_DIR/apps" ]; then
    for app_archive in "$RESTORE_STAGING_DIR"/apps/*.tar.gz; do
      [ -e "$app_archive" ] || continue
      restore_app_archive "$app_archive"
    done
  fi

  restore_database "$RESTORE_STAGING_DIR/database.sql.gz"
}

if is_full_backup_bundle; then
  restore_full_backup_bundle
else
  restore_database "$BACKUP_FILE"
fi

migrate_site
