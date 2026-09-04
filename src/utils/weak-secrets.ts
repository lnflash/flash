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

export const isWeakSecret = (secret: string | undefined | null): boolean =>
  !secret || secret.trim() === "" || WEAK_SECRETS.has(secret.trim())

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
