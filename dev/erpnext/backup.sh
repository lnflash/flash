#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

# Create backups directory on host if it doesn't exist
BACKUP_DIR="$SCRIPT_DIR/backups"
mkdir -p "$BACKUP_DIR"

cd "$REPO_ROOT"

FRAPPE_FRONTEND_SERVICE="frappe-frontend"
BACKUP_DIR_IN_CONTAINER="/tmp/backups"

docker compose exec -T "$FRAPPE_FRONTEND_SERVICE" mkdir -p "$BACKUP_DIR_IN_CONTAINER"

# Run the backup inside the container and capture output
BACKUP_OUTPUT=$(docker compose exec -T "$FRAPPE_FRONTEND_SERVICE" bench --site frontend backup --backup-path "$BACKUP_DIR_IN_CONTAINER")

# Extract the database path from the output line containing "Database:"
BACKUP_FILE=$(echo "$BACKUP_OUTPUT" | grep "Database:" | awk '{print $2}')
echo "$BACKUP_FILE"
docker compose cp "$FRAPPE_FRONTEND_SERVICE:$BACKUP_FILE" "$BACKUP_DIR/"

echo "Backups saved to: $BACKUP_DIR"
