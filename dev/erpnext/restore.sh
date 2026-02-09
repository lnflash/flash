#!/bin/bash

# Check if backup file is provided as argument
if [ -z "$1" ]; then
  echo "Usage: $0 <backup-file.sql.gz>"
  echo "Example: $0 backups/20260122_062420-frontend-database.sql.gz"
  exit 1
fi

BACKUP_FILE="$1"
DB_PASSWORD="admin" # defined in docker compose

# Check if backup file exists
if [ ! -f "$BACKUP_FILE" ]; then
  echo "Error: Backup file '$BACKUP_FILE' not found"
  exit 1
fi

# Get just the filename from the path
BACKUP_FILENAME=$(basename "$BACKUP_FILE")

# Copy the backup file from host to container restore directory
docker exec -it flash-frappe-backend-1 mkdir -p /tmp/restore
docker cp "$BACKUP_FILE" flash-frappe-backend-1:/tmp/restore/"$BACKUP_FILENAME"

# Remove stale locks if present (e.g. from frappe-create-site)
docker exec flash-frappe-backend-1 rm -f /home/frappe/frappe-bench/sites/frontend/locks/*.lock 2>/dev/null || true

# Restore the database inside the container with the password
docker exec -it flash-frappe-backend-1 bench --site frontend restore --db-root-password "$DB_PASSWORD" /tmp/restore/"$BACKUP_FILENAME"

# Run migrate to sync database schema with current code
docker exec -it flash-frappe-backend-1 bench --site frontend migrate
