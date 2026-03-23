#!/usr/bin/env bash
# Usage: ./upload-id-document.sh <upload_url> <image_file>
set -euo pipefail

UPLOAD_URL="${1:?Usage: $0 <upload_url> <image_file>}"
IMAGE_FILE="${2:?Usage: $0 <upload_url> <image_file>}"

[[ ! -f "$IMAGE_FILE" ]] && { echo "Error: file not found: $IMAGE_FILE"; exit 1; }

EXT="${IMAGE_FILE##*.}"
case "${EXT,,}" in
  jpg|jpeg) CONTENT_TYPE="image/jpeg" ;;
  png)      CONTENT_TYPE="image/png" ;;
  webp)     CONTENT_TYPE="image/webp" ;;
  *) echo "Error: unsupported file type '$EXT' (must be jpeg, png, or webp)"; exit 1 ;;
esac

echo "Uploading '$IMAGE_FILE' ($CONTENT_TYPE)..."

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PUT "$UPLOAD_URL" \
  -H "Content-Type: $CONTENT_TYPE" \
  --data-binary "@$IMAGE_FILE")

if [[ "$HTTP_STATUS" == "200" ]]; then
  echo "Upload successful (HTTP $HTTP_STATUS)"
else
  echo "Upload failed (HTTP $HTTP_STATUS)"
  exit 1
fi
