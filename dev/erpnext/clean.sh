#!/bin/bash

set -e

echo "Cleaning Frappe environment..."

# Stop and remove Frappe containers
echo "Stopping and removing Frappe containers..."
docker compose stop frappe-backend frappe-frontend frappe-websocket 2>/dev/null || true
docker compose rm -f frappe-backend frappe-frontend frappe-websocket frappe-create-site frappe-configurator 2>/dev/null || true

# Stop and remove MariaDB and Redis
echo "Stopping and removing MariaDB and Redis containers..."
docker compose stop mariadb redis 2>/dev/null || true
docker compose rm -f mariadb redis 2>/dev/null || true

# Remove Frappe volumes
echo "Removing Frappe volumes..."
docker volume rm flash_frappe-sites flash_frappe-logs 2>/dev/null || true

# Remove MariaDB volume
echo "Removing MariaDB volume..."
docker volume rm flash_mariadb-data 2>/dev/null || true

echo "✓ Frappe environment cleaned successfully!"
echo ""
echo "To start fresh, run: make start-frappe"
