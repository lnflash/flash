import { isDevContext } from "./dev-context"

// Rotated dev-only secrets committed to this repo (.env's ERPNEXT_JWT_SECRET
// and dev/config/base-config.yaml's ibex webhook secret). These look strong —
// random hex that passes an eyeball check and clears the length floor below —
// but they are publicly known, so a deployment that ships the repo defaults
// authenticates anyone who has read this repo. They are refused on every
// secret-checked surface outside a dev context.
//
// This is the whole denylist. An earlier WEAK_SECRETS set listed the obvious
// placeholders ("not-so-secret", "change-me", "<replace>", ...), but every one
// of them is shorter than MIN_SECRET_LENGTH, so the length check below already
// returned first and the set was unreachable — dead code that made three specs
// read as denylist coverage while they only exercised the floor. Anything a
// denylist still has to catch is a *long* published value, which is exactly
// what this set is for: add here, not to a second set.
const DEV_ONLY_SECRETS = new Set([
  "0a1cb6ba85cda40291e3ca4f2a777041cc59b48ba9fac2488e0bf752340c4588",
  "7189c07e9a60977492c9471a527b0d9040c1fa3c5b7bfd7e87e58db018160ddb",
])

// Length floor. A denylist only catches the placeholders we thought of; a
// short secret is just as fatal for the surfaces this guards, which are all
// HMAC/shared-secret auth. A 1-char ERPNEXT_JWT_SECRET is brute-forced offline
// from any issued admin JWT in milliseconds, and the guard would have reported
// the deployment as correctly configured. 32 is what the error message tells
// operators to generate (`openssl rand -hex 32` → 64 hex chars), so anything
// materially shorter is a misconfiguration, not a choice. It is also what
// refuses every short placeholder the repo ships.
//
// Exported so the floor is stated once: src/config/env.ts uses it to reject a
// short ERPNEXT_JWT_SECRET at config load — before anything binds a port — so
// operators get "Invalid environment variables: ERPNEXT_JWT_SECRET" instead of
// a WeakSecretError surfacing from inside a raced server start.
export const MIN_SECRET_LENGTH = 32

// "Never configured" as distinct from "configured badly". Callers that can
// legitimately run without the secret at all — an environment with no ERP
// integration never sets ERPNEXT_JWT_SECRET — use this to skip the feature
// rather than to fail the process, while a value that IS set still has to
// clear isWeakSecret.
export const isUnsetSecret = (secret: string | undefined | null): boolean =>
  !secret || secret.trim() === ""

// Dev contexts may legitimately run the committed repo values — see
// @utils/dev-context for what counts as one (NETWORK=regtest or
// FLASH_DEV_UNSAFE_MODE=true). With no dev signal the DEV_ONLY_SECRETS above
// are treated as no secret at all.
export const isWeakSecret = (secret: string | undefined | null): boolean => {
  if (isUnsetSecret(secret)) return true
  const trimmed = (secret as string).trim()
  if (trimmed.length < MIN_SECRET_LENGTH) return true
  if (!isDevContext() && DEV_ONLY_SECRETS.has(trimmed)) return true
  return false
}

export class WeakSecretError extends Error {
  constructor(name: string) {
    super(
      `${name} is unset, too short (< ${MIN_SECRET_LENGTH} chars), or a ` +
        `known-public placeholder value — refusing to start. Set a strong, ` +
        `unique secret (e.g. \`openssl rand -hex 32\`).`,
    )
    this.name = "WeakSecretError"
  }
}

// Boot-time guard: throws unless the named secret is present and not a known
// placeholder. Call at server startup so a misconfigured deployment crashes
// loudly instead of serving an unauthenticated auth path.
export const assertStrongSecret = (
  name: string,
  secret: string | undefined | null,
): void => {
  if (isWeakSecret(secret)) throw new WeakSecretError(name)
}
