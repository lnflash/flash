#!/bin/bash

BASE_CONFIG="${BASE_CONFIG:-base-config.yaml}"
OUTPUT_FILE="${CONFIG_PATH:-.}/dev-overrides.yaml"
yq ea '. as $item ireduce ({}; . * $item)' "$BASE_CONFIG" "$OUTPUT_FILE"

