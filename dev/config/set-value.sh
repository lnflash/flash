#!/bin/bash

if [ -z "$1" ]; then
  echo "Usage: $0 <key> <value>"
  exit 1
fi

key="$1"
value="$2"
OUTPUT_FILE="$CONFIG_PATH/dev-overrides.yaml"
mkdir -p "$(dirname "$OUTPUT_FILE")"

yq -i ".$key = \"$value\"" $OUTPUT_FILE