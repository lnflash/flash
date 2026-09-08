#!/usr/bin/env bash
# Prints the BYTE LENGTH of the three secrets gated by MIN_SECRET_LENGTH
# (src/utils/weak-secrets.ts), on TEST and PROD. Values are never printed.
#
# Run:  ssh root@<jumpbox> 'bash -s' < dev/bin/check-secret-lengths.sh
# Anything under 32 must be rotated before deploying a build that enforces the floor.
set -uo pipefail

len_from_yaml() {  # $1 = custom.yaml on stdin path is a pipe; $2 = dotted key
  python3 -c '
import sys, re
key = sys.argv[1].split(".")
text = sys.stdin.read()
depth, want, val = 0, key[:], None
for line in text.splitlines():
    if not line.strip() or line.lstrip().startswith("#"):
        continue
    indent = len(line) - len(line.lstrip())
    m = re.match(r"\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$", line)
    if not m:
        continue
    name, rest = m.group(1), m.group(2).strip()
    lvl = indent // 2
    if lvl < len(want) and name == want[lvl] and lvl == depth:
        if lvl == len(want) - 1:
            val = rest.strip().strip("\"'"'"'")
            break
        depth += 1
    elif lvl < depth:
        depth = lvl
print(len(val) if val else 0)
' "$2"
}

for ctx in do-tor1-flash-k8s-test do-tor1-flash-k8s-prod; do
  echo "=== ${ctx##*-}"
  K="kubectl --context $ctx -n flash"
  printf '  ERPNEXT_JWT_SECRET          = '
  $K get secret admin-api -o jsonpath='{.data.api-key}' 2>/dev/null | base64 -d | wc -c
  yaml=$($K get secret flash-config -o jsonpath='{.data.custom\.yaml}' 2>/dev/null | base64 -d)
  printf '  ibex.webhook.secret         = '
  printf '%s' "$yaml" | len_from_yaml - ibex.webhook.secret
  printf '  bridge.webhook.replaySecret = '
  printf '%s' "$yaml" | len_from_yaml - bridge.webhook.replaySecret
done
