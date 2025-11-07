#!/bin/bash

source "$(git rev-parse --show-toplevel)/test/galoy/bats/helpers/_common.bash"

DEVICE_NAME="device-user"

create_device_account "$DEVICE_NAME"

# Verify account is creation
exec_graphql "$DEVICE_NAME" 'account-details'
# local account_id="$(graphql_output '.data.me.defaultAccount.id')"
# [[ "$account_id" != "null" ]] || return 1
echo "Created device account with ID: $(graphql_output '.data.me.defaultAccount.id')"

# return 0