// Known-public placeholder secrets. These values (or close variants) appear in
// this public repo's dev configs, so they authenticate ANYONE — an auth path
// configured with one of them is an auth path with no secret at all.
//
// Every secret-checked surface must refuse to operate when its secret is unset
// or one of these values (fail closed), rather than silently authenticating
// with a publicly known key.
const WEAK_SECRETS = new Set([
  "not-so-secret",
  "also-not-so-secret",
  "change-me",
  "<replace>",
])

// Rotated dev-only secrets committed to this repo (.env's ERPNEXT_JWT_SECRET
// and dev/config/base-config.yaml's ibex webhook secret). Unlike the obvious
// placeholders above these look strong — random hex that passes an eyeball
// check — but they are just as publicly known, so a deployment that ships the
// repo defaults authenticates anyone who has read this repo. They are refused
// on every secret-checked surface outside a dev context.
const DEV_ONLY_SECRETS = new Set([
  "0a1cb6ba85cda40291e3ca4f2a777041cc59b48ba9fac2488e0bf752340c4588",
  "7189c07e9a60977492c9471a527b0d9040c1fa3c5b7bfd7e87e58db018160ddb",
])

// Dev contexts may legitimately run the committed repo values: regtest
// networks, or an explicit opt-in via ALLOW_REPO_DEV_SECRETS=true (the local
// dev stack sets it in .env — it runs NETWORK=mainnet against the Ibex
// sandbox, so NETWORK alone can't mark it as dev). Deployed environments must
// never set that flag; with it unset and NETWORK !== regtest, the committed
// values above are treated as no secret at all. Read at call time so tests
// can flip it.
const isDevContext = () =>
  process.env.NETWORK === "regtest" || process.env.ALLOW_REPO_DEV_SECRETS === "true"

export const isWeakSecret = (secret: string | undefined | null): boolean => {
  if (!secret || secret.trim() === "") return true
  const trimmed = secret.trim()
  if (WEAK_SECRETS.has(trimmed)) return true
  if (!isDevContext() && DEV_ONLY_SECRETS.has(trimmed)) return true
  return false
}

export class WeakSecretError extends Error {
  constructor(name: string) {
    super(
      `${name} is unset or a known-public placeholder value — refusing to start. ` +
        `Set a strong, unique secret (e.g. \`openssl rand -hex 32\`).`,
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
