#!/bin/bash

set -e

REPO_ROOT=$(git rev-parse --show-toplevel)
GALOY_DEV_DIR=${REPO_ROOT}/quickstart/dev
GALOY_ROOT_DIR=${REPO_ROOT}/quickstart/galoy

pushd ${REPO_ROOT}/quickstart

ytt -f vendir > vendir.yml
vendir sync

rewrite_flash_quickstart_hosts() {
  local files=(
    dev/apollo-federation/supergraph-config.yaml
    dev/apollo-federation/supergraph.graphql
    dev/ory/kratos.yml
    dev/ory/oathkeeper_rules.yaml
  )

  for file in "${files[@]}"; do
    sed -i.bak 's#http://bats-tests:#http://flash:#g' "${file}"
    rm -f "${file}.bak"
  done

  local app_check_files=(
    dev/ory/oathkeeper.yml
    dev/ory/oathkeeper_rules.yaml
  )

  for file in "${app_check_files[@]}"; do
    sed -i.bak \
      -e 's#- id: galoy-ws#- id: flash-ws#' \
      -e 's#- id: galoy-backend#- id: flash-backend#' \
      -e 's#firebaseappcheck.googleapis.com/72279297366#firebaseappcheck.googleapis.com/806646140435#' \
      -e 's#projects/72279297366#projects/806646140435#' \
      "${file}"
    rm -f "${file}.bak"
  done
}

rewrite_flash_quickstart_hosts

ytt -f ./docker-compose.tmpl.yml -f ${GALOY_ROOT_DIR}/docker-compose.yml -f ${GALOY_ROOT_DIR}/docker-compose.override.yml > docker-compose.yml

pushd ${GALOY_ROOT_DIR}
source .env
mkdir -p "${GALOY_ROOT_DIR}/../vendor/galoy-quickstart/env"

export OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-agent:4318
envsubst < .env.ci | grep -v '^LND2' > ${GALOY_ROOT_DIR}/../.env.galoy
