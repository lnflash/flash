#!/usr/bin/env bash
set -euo pipefail

config_path="dev/apollo-federation/supergraph-config.yaml"
output_path="dev/apollo-federation/supergraph.graphql"
tmp_path="$(mktemp "${output_path}.XXXXXX")"

cleanup() {
  rm -f "${tmp_path}"
}
trap cleanup EXIT

for attempt in 1 2 3; do
  if rover supergraph compose \
    --config "${config_path}" \
    --elv2-license accept \
    > "${tmp_path}"; then
    mv "${tmp_path}" "${output_path}"
    trap - EXIT
    exit 0
  fi

  if [ "${attempt}" -lt 3 ]; then
    sleep $((attempt * 5))
  fi
done

exit 1
