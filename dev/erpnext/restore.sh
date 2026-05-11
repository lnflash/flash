#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

# Check if backup file is provided as argument
if [ -z "${1:-}" ]; then
  echo "Usage: $0 <backup-file.sql.gz>"
  echo "Example: $0 backups/20260122_062420-frontend-database.sql.gz"
  exit 1
fi

BACKUP_FILE="$1"
DB_PASSWORD="admin" # defined in docker compose
FRAPPE_BACKEND_SERVICE="frappe-backend"
SITE_NAME="frontend"
RESTORE_DIR="/tmp/restore"

# Check if backup file exists
if [ ! -f "$BACKUP_FILE" ]; then
  echo "Error: Backup file '$BACKUP_FILE' not found"
  exit 1
fi

# Get absolute backup path before switching to repo root for docker compose.
BACKUP_FILE=$(cd "$(dirname "$BACKUP_FILE")" && pwd)/$(basename "$BACKUP_FILE")
BACKUP_FILENAME=$(basename "$BACKUP_FILE")

cd "$REPO_ROOT"

# Copy the backup file from host to container restore directory
docker compose exec -T "$FRAPPE_BACKEND_SERVICE" mkdir -p "$RESTORE_DIR"
docker compose cp "$BACKUP_FILE" "$FRAPPE_BACKEND_SERVICE:$RESTORE_DIR/$BACKUP_FILENAME"

# Remove stale locks if present (e.g. from frappe-create-site)
docker compose exec -T "$FRAPPE_BACKEND_SERVICE" rm -f "/home/frappe/frappe-bench/sites/$SITE_NAME/locks/"*.lock 2>/dev/null || true

# Restore the database inside the container with the password
docker compose exec -T "$FRAPPE_BACKEND_SERVICE" bench --site "$SITE_NAME" restore --db-root-password "$DB_PASSWORD" "$RESTORE_DIR/$BACKUP_FILENAME"

# Run migrate to sync database schema with current code
echo "Migrating $SITE_NAME"
docker compose exec -T "$FRAPPE_BACKEND_SERVICE" bench --site "$SITE_NAME" migrate || {
  echo "Migration failed, retrying..."
  sleep 5
  docker compose exec -T "$FRAPPE_BACKEND_SERVICE" bench --site "$SITE_NAME" migrate
}
