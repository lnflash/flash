#!/bin/bash

set -e

COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-quickstart}"

DIR="$(dirname "$(readlink -f "$BASH_SOURCE")")"
source ${DIR}/helpers.sh

show_flash() {
cat << "EOF"
Flash quickstart
EOF
}

main() {
  show_flash
  echo "------------------------------------------------------------"
  echo "------------------------------------------------------------"
  echo
  echo "Checking Flash public GraphQL endpoint"

  echo "Running on network:"
  for i in {1..90}; do
    exec_graphql "anon" "globals"
    [[ "$(echo $output | jq -r '.data.globals.network')" = 'regtest' ]] && break
    sleep 1
  done
  echo $output | jq -r '.data.globals.network'
  if [[ "$(echo $output | jq -r '.data.globals.network')" != 'regtest' ]]; then
    echo "Unexpected globals response:"
    echo "$output" | jq .
    exit 1
  fi

  echo "DONE"
}

main
