#!/bin/bash

source "$(git rev-parse --show-toplevel)/test/galoy/bats/helpers/_common.bash"

DEVICE_NAME="device-user"
DEVICE_PHONE="+16505554353"

token_name="$DEVICE_NAME"
phone="$DEVICE_PHONE"
code="$CODE"

variables=$(
  jq -n \
  --arg phone "$phone" \
 --arg code "$code" \
  '{input: {phone: $phone, code: $code}}'
)

exec_graphql "$token_name" 'user-login-upgrade' "$variables"
upgrade_success="$(graphql_output '.data.userLoginUpgrade.success')"
[[ "$upgrade_success" == "true" ]] || exit 1

# Existing phone accounts return an authToken
upgrade_auth_token="$(graphql_output '.data.userLoginUpgrade.authToken')"
[[ "$upgrade_auth_token" == "null" ]] || exit 1

exec_graphql "$token_name" 'account-details'
account_level="$(graphql_output '.data.me.defaultAccount.level')"
[[ "$account_level" == "ONE" ]] || exit 1
