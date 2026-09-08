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
})
