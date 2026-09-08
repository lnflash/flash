import { MIN_SECRET_LENGTH } from "@utils/weak-secrets"

// `src/config/env.ts` has no path alias of its own (only `@config` → the
// index), so this reaches it directly to re-run createEnv against a doctored
// process.env.
const ENV_MODULE = "../../../../src/config/env"

const savedSecret = process.env.ERPNEXT_JWT_SECRET

// A fresh createEnv run with ERPNEXT_JWT_SECRET set to `secret`. Returns the
// thrown error, or null when the environment validated.
const loadEnvWithSecret = (secret: string | undefined): Error | null => {
  if (secret === undefined) delete process.env.ERPNEXT_JWT_SECRET
  else process.env.ERPNEXT_JWT_SECRET = secret

  let thrown: Error | null = null
  jest.isolateModules(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require(ENV_MODULE)
    } catch (err) {
      thrown = err as Error
    }
  })
  return thrown
}

// The 32-char floor used to live only in the admin server's boot guard, where
// it surfaced as a WeakSecretError thrown from inside one of two raced server
// starts — which, in the api process, takes the PUBLIC GraphQL API down with
// it. Rejecting the same value at config load turns that into a named,
// legible "Invalid environment variables" failure before anything binds a port.
describe("ERPNEXT_JWT_SECRET length floor at config load", () => {
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.ERPNEXT_JWT_SECRET
    else process.env.ERPNEXT_JWT_SECRET = savedSecret
  })

  // isWeakSecret trims before measuring; a bare `.min()` counts raw bytes. A
  // k8s --from-file secret carries a trailing newline, so a 31-char value can
  // present as 32 raw — passing config load and then throwing WeakSecretError
  // from inside a raced server start, which is what this floor exists to stop.
  it("measures the trimmed length, so a padded short secret is still refused", () => {
    const padded = "a".repeat(MIN_SECRET_LENGTH - 1) + "\n"
    expect(padded.length).toBeGreaterThanOrEqual(MIN_SECRET_LENGTH)
    expect(loadEnvWithSecret(padded)).toBeInstanceOf(Error)
  })

  it("accepts a secret that only reaches the floor once padding is ignored", () => {
    expect(loadEnvWithSecret("a".repeat(MIN_SECRET_LENGTH) + "\n")).toBeNull()
  })

  it("rejects a set-but-short secret, naming the variable", () => {
    const err = loadEnvWithSecret("a".repeat(MIN_SECRET_LENGTH - 1))

    expect(err).toBeInstanceOf(Error)
    expect(err?.message).toMatch(/Invalid environment variables/)
    expect(err?.message).toMatch(/ERPNEXT_JWT_SECRET/)
  })

  it("accepts a secret at the floor", () => {
    expect(loadEnvWithSecret("a".repeat(MIN_SECRET_LENGTH))).toBeNull()
  })

  // Optional stays optional: an environment that never sets the variable is
  // untouched by this change — only a value that IS set and too short fails.
  it("leaves an unset secret alone", () => {
    expect(loadEnvWithSecret(undefined)).toBeNull()
  })

  // The floor and `isUnsetSecret` (@utils/weak-secrets) have to agree on what
  // "unset" means, or the two layers contradict each other: the servers use
  // isUnsetSecret to tell "no ERP integration here" from "configured badly" and
  // skip the admin mount (see admin-auth.spec.ts, which asserts exactly "" and
  // "   " keep the process alive) — but a config-load refusal never lets the
  // process reach that branch. A chart or compose file rendering
  // ERPNEXT_JWT_SECRET: "" for a fresh namespace would put the whole payments
  // API in CrashLoopBackOff instead. Blank is still weak everywhere it
  // matters: the dedicated admin entrypoint calls assertStrongSecret.
  it.each([
    ["empty", ""],
    ["blank", "   "],
  ])("treats an %s value as unset, matching isUnsetSecret", (_label, secret) => {
    expect(loadEnvWithSecret(secret)).toBeNull()
  })
})
