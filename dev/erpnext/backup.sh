#!/bin/bash

# Create backups directory on host if it doesn't exist
BACKUP_DIR="$(dirname "$0")/backups"
mkdir -p "$BACKUP_DIR"

docker exec -it flash-frappe-frontend-1 mkdir -p /tmp/backups

# Run the backup inside the container and capture output
BACKUP_OUTPUT=$(docker exec flash-frappe-frontend-1 bench --site frontend backup --backup-path /tmp/backups)

# Extract the database path from the output line containing "Database:"
BACKUP_FILE=$(echo "$BACKUP_OUTPUT" | grep "Database:" | awk '{print $2}') 
echo $BACKUP_FILE
docker cp flash-frappe-frontend-1:$BACKUP_FILE "$BACKUP_DIR/"

echo "Backups saved to: $BACKUP_DIR"                
