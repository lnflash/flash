REPO_ROOT=$(git rev-parse --show-toplevel)
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-${REPO_ROOT##*/}}"

CACHE_DIR=${BATS_TMPDIR:-tmp/bats}/galoy-bats-cache
mkdir -p $CACHE_DIR

GALOY_ENDPOINT=${GALOY_ENDPOINT:-localhost:4002}

ALICE_TOKEN_NAME="alice"
ALICE_PHONE="+16505554328"

BOB_TOKEN_NAME="bob"
BOB_PHONE="+16505554350"

CODE="000000"

if ! type fail &>/dev/null; then
  fail() {
    echo "$1"
    exit 1
  }
fi


bitcoin_cli() {
  docker exec "${COMPOSE_PROJECT_NAME}-bitcoind-1" bitcoin-cli $@
}

bria_cli() {
  docker exec "${COMPOSE_PROJECT_NAME}-bria-1" bria $@
}

cache_value() {
  echo $2 >${CACHE_DIR}/$1
}

read_value() {
  cat ${CACHE_DIR}/$1
}

is_number() {
  if ! [[ $1 =~ ^-?[0-9]+$ ]]; then
    echo "Error: Input is not a number"
    exit 1
  fi
}

abs() {
  is_number $1 || return 1

  if [[ $1 -lt 0 ]]; then
    echo "$((- $1))"
  else
    echo "$1"
  fi
}

# Run the given command in the background. Useful for starting a
# node and then moving on with commands that exercise it for the
# test.
#
# Ensures that BATS' handling of file handles is taken into account;
# see
# https://github.com/bats-core/bats-core#printing-to-the-terminal
# https://github.com/sstephenson/bats/issues/80#issuecomment-174101686
# for details.
background() {
  "$@" 3>- &
  echo $!
}

# Taken from https://github.com/docker/swarm/blob/master/test/integration/helpers.bash
# Retry a command $1 times until it succeeds. Wait $2 seconds between retries.
retry() {
  local attempts=$1
  shift
  local delay=$1
  shift
  local i

  for ((i = 0; i < attempts; i++)); do
    if [[ "${BATS_TEST_DIRNAME}" = "" ]]; then
      "$@"
    else
      run "$@"
    fi

    if [[ "$status" -eq 0 ]]; then
      return 0
    fi
    sleep "$delay"
  done

  echo "Command \"$*\" failed $attempts times. Output: $output"
  false
}

gql_query() {
  cat "$(gql_file $1)" | tr '\n' ' ' | sed 's/"/\\"/g'
}

gql_file() {
  echo "${BATS_TEST_DIRNAME:-${REPO_ROOT}/test/galoy/bats}/gql/$1.gql"
}

gql_admin_query() {
  cat "$(gql_admin_file $1)" | tr '\n' ' ' | sed 's/"/\\"/g'
}

gql_admin_file() {
  echo "${BATS_TEST_DIRNAME:-${REPO_ROOT}/test/bats}/admin-gql/$1.gql"
}

new_idempotency_key() {
  random_uuid
}

exec_graphql() {
  local token_name=$1
  local query_name=$2
  local variables=${3:-"{}"}
  echo "GQL query -  user: ${token_name} -  query: ${query_name} -  vars: ${variables}"
  echo "{\"query\": \"$(gql_query $query_name)\", \"variables\": $variables}"

  if [[ ${token_name} == "anon" ]]; then
    AUTH_HEADER=""
  else
    AUTH_HEADER="Authorization: Bearer $(read_value ${token_name})"
  fi

  if [[ "${BATS_TEST_DIRNAME}" != "" ]]; then
    run_cmd="run"
  else
    run_cmd=""
  fi

  gql_route="graphql"

  if [[ "${BATS_TEST_DIRNAME}" != "" ]]; then
    # In BATS: run command captures output into $output
    ${run_cmd} curl -s \
      -X POST \
      ${AUTH_HEADER:+ -H "$AUTH_HEADER"} \
      -H "Content-Type: application/json" \
      -H "X-Idempotency-Key: $(new_idempotency_key)" \
      -d "{\"query\": \"$(gql_query $query_name)\", \"variables\": $variables}" \
      "${GALOY_ENDPOINT}/${gql_route}"
  else
    # Outside BATS: manually capture output
    output=$(curl -s \
      -X POST \
      ${AUTH_HEADER:+ -H "$AUTH_HEADER"} \
      -H "Content-Type: application/json" \
      -H "X-Idempotency-Key: $(new_idempotency_key)" \
      -d "{\"query\": \"$(gql_query $query_name)\", \"variables\": $variables}" \
      "${GALOY_ENDPOINT}/${gql_route}")
  fi

  echo "GQL output: '$output'"
}

exec_admin_graphql() {
  local token_name=$1
  local query_name=$2
  local variables=${3:-"{}"}
  echo "GQL query -  user: ${token_name} -  query: ${query_name} -  vars: ${variables}"
  echo "{\"query\": \"$(gql_admin_query $query_name)\", \"variables\": $variables}"

  if [[ ${token_name} == "anon" ]]; then
    AUTH_HEADER=""
  else
    AUTH_HEADER="Authorization: Bearer $(read_value ${token_name})"
  fi

  if [[ "${BATS_TEST_DIRNAME}" != "" ]]; then
    run_cmd="run"
  else
    run_cmd=""
  fi

  gql_route="admin/graphql"

  if [[ "${BATS_TEST_DIRNAME}" != "" ]]; then
    # In BATS: run command captures output into $output
    ${run_cmd} curl -s \
      -X POST \
      ${AUTH_HEADER:+ -H "$AUTH_HEADER"} \
      -H "Content-Type: application/json" \
      -d "{\"query\": \"$(gql_admin_query $query_name)\", \"variables\": $variables}" \
      "${GALOY_ENDPOINT}/${gql_route}"
  else
    # Outside BATS: manually capture output
    output=$(curl -s \
      -X POST \
      ${AUTH_HEADER:+ -H "$AUTH_HEADER"} \
      -H "Content-Type: application/json" \
      -d "{\"query\": \"$(gql_admin_query $query_name)\", \"variables\": $variables}" \
      "${GALOY_ENDPOINT}/${gql_route}")
  fi

  echo "GQL output: '$output'"
}

graphql_output() {
  echo $output | jq -r "$@"
}

random_uuid() {
  if [[ -e /proc/sys/kernel/random/uuid ]]; then
    cat /proc/sys/kernel/random/uuid
  else
    uuidgen
  fi
}

curl_request() {
  local url=$1
  shift
  local data=${1:-""}
  shift
  local headers=("$@")

  echo "Curl request -  url: ${url} -  data: ${data}"

  if [[ "${BATS_TEST_DIRNAME}" != "" ]]; then
    run_cmd="run"
  else
    run_cmd=""
  fi

  cmd=(${run_cmd} curl -s -X POST -H "Content-Type: application/json")

  for header in "${headers[@]}"; do
    cmd+=(-H "$header")
  done

  if [[ -n "$data" ]]; then
    cmd+=(-d "${data}")
  fi

  cmd+=("${url}")

  if [[ "${BATS_TEST_DIRNAME}" != "" ]]; then
    # In BATS: run command captures output into $output
    "${cmd[@]}"
  else
    # Outside BATS: manually capture output
    output=$("${cmd[@]}")
  fi

  echo "Curl output: '$output'"
}

curl_output() {
  echo $output | jq -r "$@"
}

is_contact() {
  local token_name="$1"
  local contact_username="$2"

  exec_graphql "$token_name" 'contacts'
  local fetched_username=$(
    graphql_output \
    --arg contact_username "$contact_username" \
    '.data.me.contacts[] | select(.username == $contact_username) .username'
  )
  [[ "$fetched_username" == "$contact_username" ]] || return 1
}

create_device_account() {
    local token_name="$1"
    local url="http://${GALOY_ENDPOINT}/auth/create/device-account"

    # dev/ory/gen-test-jwt.ts
    local jwt="eyJhbGciOiJSUzI1NiIsImtpZCI6IjFiOTdiMjIxLWNhMDgtNGViMi05ZDA5LWE1NzcwZmNjZWIzNyJ9.eyJzdWIiOiIxOjgwNjY0NjE0MDQzNTphbmRyb2lkOmE4YTBjY2ZlODhiZWUxNWIwNmY5ZTYiLCJhdWQiOlsicHJvamVjdHMvODA2NjQ2MTQwNDM1IiwicHJvamVjdHMvYXZpZC1jZWlsaW5nLTM5MDQxOCJdLCJwcm92aWRlciI6ImRlYnVnIiwiaXNzIjoiaHR0cHM6Ly9maXJlYmFzZWFwcGNoZWNrLmdvb2dsZWFwaXMuY29tLzgwNjY0NjE0MDQzNSIsImV4cCI6MjYzOTAwMDA2OX0.cgE2pX3srSzlPreJpBDLaFmPQn9CyKoxW1f-hFgVbGZ7xwWysogsNTrV0eIkvgDnZWjbjexOxf4HhuK2MSBmnRYTWgk6LC7LNoq_KPNAvxkMNj1HGSYh34q2uYafcc1LZCREDvPFTw-JN6FJOAzk7TbWwi8A8-Z8ed5W1kqzkWu_D79nZNWZuN6tUpoeyj1c77Cb7wn5UBlSBhoNrfxXOQKTsKTmuFpcR2P3zv_R9D-yedizqLpG75XJkJd6_4zuhhrW05nMgOHULQ2bTt3PTbi6dy64ObLwMOT5vevqqbKc303-rk02sDGCdRc251nL5sIvTIcajXUXs-Ruy3Op4g"  # the JWT token

    local username="$(random_uuid)"
    local password="$(random_uuid)"

    if [[ "$(uname)" == "Linux" ]]; then
      local basic_token="$(echo -n $username:$password | base64 -w 0)"
    else
      local basic_token="$(echo -n $username:$password | base64)"
    fi

    local auth_header="Authorization: Basic $basic_token"
    local appcheck_header="Appcheck: $jwt"

    # Create account
    curl_request "$url" "" "$auth_header" "$appcheck_header"
    local auth_token="$(echo $output | jq -r '.result')"
    [[ "$auth_token" != "null" ]] || return 1
    cache_value "$token_name" "$auth_token"
  }
