#!/bin/bash

OUTPUT_FILE="$CONFIG_PATH/dev-overrides.yaml"
yq ea '. as $item ireduce ({}; . * $item)' base-config.yaml $OUTPUT_FILE

