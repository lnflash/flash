#!/bin/bash
#
# Splice the pre-persist registration web hook into a freshly vendir-synced
# quickstart/dev/ory/kratos.yml.
#
# Upstream galoy ships that hook commented out ("we are not sure if we need
# this hook yet"). The api's POST /kratos/preregistration route is what keeps a
# rejected sign-up from leaving an orphaned Kratos identity behind, and Kratos
# only calls it when told to, with `response.parse: true` (pre-persist), ahead
# of the post-persist /registration hook. The root dev/ory/kratos.yml carries
# the real entry for the integration suite; the quickstart copy is regenerated
# from upstream by re-render.sh, so a hand edit there is lost on the next
# `make re-render` -- which is why the entry is spliced in here instead.
#
# Usage: splice-kratos-preregistration-hook.sh <path/to/kratos.yml>
#   Run after the bats-tests -> flash host rewrite; it anchors on the flash host.
#
# Exits 0 and leaves the file alone when an uncommented preregistration hook is
# already there. Exits 1 when the /registration hook cannot be found in the
# expected shape, so a re-render can never silently produce a config without
# the hook. test/flash/unit/dev/kratos-registration-hooks.spec.ts covers it.

set -e
set -o pipefail

file=${1:?usage: $0 <kratos.yml>}

registration_url='http://flash:4012/kratos/registration'
preregistration_url='http://flash:4012/kratos/preregistration'

existing_line=$(grep -nE "^[[:space:]]*url: ${preregistration_url}[[:space:]]*\$" "${file}" | head -1 | cut -d: -f1 || true)
if [ -n "${existing_line}" ]; then
  # A hook at that url only does its job pre-persist. If upstream ever ships
  # it with `parse: false` (or drops `response` entirely) this must fail
  # loudly, not report "already present".
  if sed -n "${existing_line},$((existing_line + 4))p" "${file}" | grep -Eq '^[[:space:]]*parse: true[[:space:]]*$'; then
    echo "${file}: pre-persist registration hook already present, nothing to splice" >&2
    exit 0
  fi
  echo "${file}: a /kratos/preregistration hook is present but is not pre-persist (no 'response.parse: true' within 4 lines of line ${existing_line}); fix it by hand" >&2
  exit 1
fi

# Anchor on the post-persist hook, expected as three consecutive lines:
#   - hook: web_hook
#     config:
#       url: http://flash:4012/kratos/registration
url_lines=$(grep -nE "^[[:space:]]*url: ${registration_url}[[:space:]]*\$" "${file}" | cut -d: -f1 || true)
if [ "$(printf '%s\n' "${url_lines}" | grep -c .)" -ne 1 ]; then
  echo "${file}: expected exactly one 'url: ${registration_url}' line, got: '${url_lines}'" >&2
  exit 1
fi
url_line=${url_lines}
hook_line=$((url_line - 2))
if [ "${hook_line}" -lt 1 ] \
  || ! sed -n "${hook_line}p" "${file}" | grep -Eq '^[[:space:]]*- hook: web_hook[[:space:]]*$' \
  || ! sed -n "$((url_line - 1))p" "${file}" | grep -Eq '^[[:space:]]*config:[[:space:]]*$'; then
  echo "${file}: the /registration hook (line ${url_line}) is not laid out as '- hook: web_hook' / 'config:' / 'url:'; update $(basename "$0")" >&2
  exit 1
fi

indent=$(sed -n "${hook_line}p" "${file}" | sed -E 's/^([[:space:]]*).*/\1/')

# Upstream keeps its commented-out draft of this very hook right above the
# /registration entry. The real entry supersedes it, so drop the run of comment
# lines leading into the anchor when it mentions the hook; keep any other
# comment.
drop_from=${hook_line}
while [ "${drop_from}" -gt 1 ] \
  && sed -n "$((drop_from - 1))p" "${file}" | grep -Eq '^[[:space:]]*(#.*)?$'; do
  drop_from=$((drop_from - 1))
done
if [ "${drop_from}" -lt "${hook_line}" ] \
  && ! sed -n "${drop_from},$((hook_line - 1))p" "${file}" | grep -q 'kratos/preregistration'; then
  drop_from=${hook_line}
fi

# Mirrors the entry in dev/ory/kratos.yml at the repo root, host rewritten.
block=$(cat <<'BLOCK'
# Pre-persist validation, spliced in by quickstart/bin/re-render.sh (upstream
# ships it commented out). `response.parse: true` makes Kratos run this hook
# BEFORE the identity is written: a 4xx with a `messages` body aborts the
# sign-up and nothing is persisted. See dev/ory/kratos.yml at the repo root.
- hook: web_hook
  config:
    url: http://flash:4012/kratos/preregistration
    method: POST
    response:
      parse: true
    body: file:///home/ory/body.jsonnet
    auth:
      type: api_key
      config:
        name: Authorization
        value: The-Value-of-My-Key
        in: header
BLOCK
)

tmp="${file}.splice.tmp"
# The block goes through the environment: awk -v would interpret escapes and
# some awks choke on embedded newlines there.
SPLICE_BLOCK="${block}" awk \
  -v hook_line="${hook_line}" -v drop_from="${drop_from}" -v indent="${indent}" '
  FNR >= drop_from && FNR < hook_line && $0 ~ /^[[:space:]]*(#.*)?$/ { next }
  FNR == hook_line {
    n = split(ENVIRON["SPLICE_BLOCK"], lines, "\n")
    for (i = 1; i <= n; i++) print indent lines[i]
  }
  { print }
' "${file}" > "${tmp}"
mv "${tmp}" "${file}"
echo "${file}: spliced pre-persist /kratos/preregistration hook ahead of /kratos/registration" >&2
