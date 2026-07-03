#!/bin/bash

set -eu

export digest=$(cat ./edge-image/digest)
export migrate_digest=$(cat ./migrate-edge-image/digest)
export websocket_digest=$(cat ./websocket-edge-image/digest)
export ref=$(cat ./repo/.git/short_ref)
export app_version=$(cat version/version)

mkdir -p charts-repo/charts/flash/apollo-router
cp ./repo/dev/apollo-federation/supergraph.graphql ./charts-repo/charts/flash/apollo-router/supergraph.graphql

pushd charts-repo

yq -i e '.galoy.images.app.digest = strenv(digest)' ./charts/flash/values.yaml
yq -i e '.galoy.images.app.git_ref = strenv(ref)' ./charts/flash/values.yaml
yq -i e '.galoy.images.mongodbMigrate.digest = strenv(migrate_digest)' ./charts/flash/values.yaml
yq -i e '.galoy.images.websocket.digest = strenv(websocket_digest)' ./charts/flash/values.yaml
yq -i e '.appVersion = strenv(app_version)' ./charts/flash/Chart.yaml

# Bump the chart's own semver patch on every image bump. This is load-bearing
# for the deploy: package-releases.sh publishes with `helm push ... | grep -v
# "already exists"`, so if `version` is unchanged the push silently no-ops and
# the OCI registry keeps the stale chart — a terraform apply then re-pulls the
# old image. A fresh patch version means every image bump is a distinct,
# publishable, deployable chart. Was previously a manual edit.
export chart_version=$(yq e '.version' ./charts/flash/Chart.yaml)
export new_chart_version=$(echo "${chart_version}" | awk -F. '{ printf "%d.%d.%d", $1, $2, $3 + 1 }')
yq -i e '.version = strenv(new_chart_version)' ./charts/flash/Chart.yaml

if [[ -z $(git config --global user.email) ]]; then
  git config --global user.email "bot@flash.io"
fi
if [[ -z $(git config --global user.name) ]]; then
  git config --global user.name "CI Bot"
fi

(
  cd $(git rev-parse --show-toplevel)
  git merge --no-edit ${BRANCH}
  git add -A
  git status
  git commit -m "chore(deps): bump flash image to '${digest}' (chart ${new_chart_version})"
)
