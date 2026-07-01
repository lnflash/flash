#!/bin/bash
set -euo pipefail

docker compose up frappe -d
docker compose up frappe-frontend -d --force-recreate

echo "Login to http://frontend.local:8080/#login"
echo "Username: Administrator" 
echo "Password: admin"
