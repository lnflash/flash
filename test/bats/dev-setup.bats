#!/usr/bin/env bats
# Tests for dev/setup.sh non-interactive behaviour at the Ibex credential prompt.
#
# Runs the real script against a PATH-prepended stub dir (node/yarn/docker) with
# a throwaway cwd, HOME and CONFIG_PATH so nothing touches the developer's
# machine. No Docker daemon, network, or yarn install is needed.

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
SETUP_SH="$REPO_ROOT/dev/setup.sh"
NO_INPUT_HINT="No input available for the Ibex prompt"

setup() {
  WORK="$(mktemp -d)"
  STUBS="$WORK/stubs"
  mkdir -p "$STUBS" "$WORK/home" "$WORK/config" "$WORK/cwd"

  cat > "$STUBS/node" << 'EOF'
#!/bin/bash
[ "$1" = "--version" ] && { echo "v24.0.0"; exit 0; }
exit 0
EOF
  cat > "$STUBS/yarn" << 'EOF'
#!/bin/bash
[ "$1" = "--version" ] && { echo "1.22.22"; exit 0; }
exit 0
EOF
  cat > "$STUBS/docker" << 'EOF'
#!/bin/bash
[ "$1" = "--version" ] && { echo "Docker version 27.0.0, build test"; exit 0; }
exit 0
EOF
  chmod +x "$STUBS"/*

  export PATH="$STUBS:$PATH"
  export HOME="$WORK/home"
  export CONFIG_PATH="$WORK/config"
  cd "$WORK/cwd" || return 1
}

teardown() {
  rm -rf "$WORK"
}

@test "closed stdin at Ibex prompt fails with hint and writes no .env.local" {
  run bash "$SETUP_SH" < /dev/null
  [ "$status" -eq 1 ]
  [[ "$output" == *"$NO_INPUT_HINT"* ]]
  [[ "$output" == *"--skip-ibex"* ]]
  [ ! -f .env.local ]
}

@test "--skip-ibex with closed stdin exits 0 without prompting" {
  run bash "$SETUP_SH" --skip-ibex < /dev/null
  [ "$status" -eq 0 ]
  [[ "$output" == *"Skipped (--skip-ibex)"* ]]
  [[ "$output" != *"$NO_INPUT_HINT"* ]]
  [ ! -f .env.local ]
}

@test "piped id and secret write .env.local and overrides" {
  run bash -c "printf 'my-id\nmy-secret\n' | bash '$SETUP_SH'"
  [ "$status" -eq 0 ]
  [ -f .env.local ]
  grep -q "export IBEX_CLIENT_ID='my-id'" .env.local
  grep -q "export IBEX_CLIENT_SECRET='my-secret'" .env.local
  grep -q "clientId: my-id" "$CONFIG_PATH/dev-overrides.yaml"
  grep -q "clientSecret: my-secret" "$CONFIG_PATH/dev-overrides.yaml"
}

@test "piped secret without trailing newline is still accepted" {
  # read returns non-zero on EOF even when it populated the variable; the
  # script must treat a populated variable as success.
  run bash -c "printf 'my-id\nmy-secret' | bash '$SETUP_SH'"
  [ "$status" -eq 0 ]
  [[ "$output" != *"$NO_INPUT_HINT"* ]]
  [ -f .env.local ]
  grep -q "export IBEX_CLIENT_SECRET='my-secret'" .env.local
}

@test "piped id without trailing newline then closed stdin fails at the secret prompt" {
  run bash -c "printf 'my-id' | bash '$SETUP_SH'"
  [ "$status" -eq 1 ]
  [[ "$output" == *"$NO_INPUT_HINT"* ]]
  [ ! -f .env.local ]
}

@test "empty Enter at the id prompt skips credentials and exits 0" {
  run bash -c "printf '\n' | bash '$SETUP_SH'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Skipped"* ]]
  [[ "$output" != *"$NO_INPUT_HINT"* ]]
  [ ! -f .env.local ]
}

@test "existing .env.local with IBEX_CLIENT_ID is not prompted for" {
  printf "export IBEX_CLIENT_ID='existing'\nexport IBEX_CLIENT_SECRET='sec'\n" > .env.local
  run bash "$SETUP_SH" < /dev/null
  [ "$status" -eq 0 ]
  [[ "$output" == *"Ibex credentials found in .env.local"* ]]
  grep -q "export IBEX_CLIENT_ID='existing'" .env.local
}
