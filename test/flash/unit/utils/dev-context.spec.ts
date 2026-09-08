jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import {
  DEPRECATED_DEV_UNSAFE_MODE_FLAG,
  DEV_UNSAFE_MODE_FLAG,
  isDevContext,
  warnIfDevContext,
} from "@utils/dev-context"
import { baseLogger } from "@services/logger"

const warn = baseLogger.warn as unknown as jest.Mock

const savedNetwork = process.env.NETWORK
const savedFlag = process.env[DEV_UNSAFE_MODE_FLAG]
const savedDeprecatedFlag = process.env[DEPRECATED_DEV_UNSAFE_MODE_FLAG]

const restoreEnv = () => {
  if (savedNetwork === undefined) delete process.env.NETWORK
  else process.env.NETWORK = savedNetwork
  if (savedFlag === undefined) delete process.env[DEV_UNSAFE_MODE_FLAG]
  else process.env[DEV_UNSAFE_MODE_FLAG] = savedFlag
  if (savedDeprecatedFlag === undefined)
    delete process.env[DEPRECATED_DEV_UNSAFE_MODE_FLAG]
  else process.env[DEPRECATED_DEV_UNSAFE_MODE_FLAG] = savedDeprecatedFlag
}

const clearFlags = () => {
  delete process.env[DEV_UNSAFE_MODE_FLAG]
  delete process.env[DEPRECATED_DEV_UNSAFE_MODE_FLAG]
}

// One predicate, two consumers: the weak-secret refusal and the SSRF guard.
// Before this existed they disagreed — the SSRF guard keyed only on
// NETWORK=regtest while the local dev stack runs NETWORK=mainnet with the dev
// flag set, so a developer with a localhost lnurlp got a 502 and a comment
// claiming regtest covered them.
describe("isDevContext", () => {
  afterEach(restoreEnv)

  it("is true on regtest", () => {
    process.env.NETWORK = "regtest"
    clearFlags()
    expect(isDevContext()).toBe(true)
  })

  it("is true on mainnet with the explicit opt-in (the repo's own dev stack)", () => {
    process.env.NETWORK = "mainnet"
    clearFlags()
    process.env[DEV_UNSAFE_MODE_FLAG] = "true"
    expect(isDevContext()).toBe(true)
  })

  // The flag was renamed to say what it actually does (it disables the SSRF
  // guard too, not just the secret refusal). An install still carrying the old
  // name in its .env must not silently lose its dev escape hatch.
  it("still honours the deprecated ALLOW_REPO_DEV_SECRETS alias", () => {
    process.env.NETWORK = "mainnet"
    clearFlags()
    process.env[DEPRECATED_DEV_UNSAFE_MODE_FLAG] = "true"
    expect(isDevContext()).toBe(true)
  })

  it("is false for a deployed environment", () => {
    process.env.NETWORK = "mainnet"
    clearFlags()
    expect(isDevContext()).toBe(false)

    process.env.NETWORK = "signet"
    expect(isDevContext()).toBe(false)
  })

  it("only accepts the exact opt-in value", () => {
    process.env.NETWORK = "mainnet"
    for (const value of ["1", "yes", "TRUE", ""]) {
      clearFlags()
      process.env[DEV_UNSAFE_MODE_FLAG] = value
      expect(isDevContext()).toBe(false)

      clearFlags()
      process.env[DEPRECATED_DEV_UNSAFE_MODE_FLAG] = value
      expect(isDevContext()).toBe(false)
    }
  })

  it("is read at call time, not import time", () => {
    process.env.NETWORK = "mainnet"
    clearFlags()
    expect(isDevContext()).toBe(false)
    process.env.NETWORK = "regtest"
    expect(isDevContext()).toBe(true)
  })
})

// One env var turns off the weak-secret refusal AND the whole SSRF guard on a
// public unauthenticated route. Before this warning the only record of that
// state was the config file that set it — nothing in the process's own logs.
describe("warnIfDevContext", () => {
  beforeEach(() => {
    warn.mockClear()
  })
  afterEach(restoreEnv)

  const messages = () => warn.mock.calls.map((call) => String(call[call.length - 1]))

  it("says nothing in a deployed environment", () => {
    process.env.NETWORK = "mainnet"
    clearFlags()

    warnIfDevContext()

    expect(warn).not.toHaveBeenCalled()
  })

  it("warns on regtest", () => {
    process.env.NETWORK = "regtest"
    clearFlags()

    warnIfDevContext()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(messages()[0]).toMatch(/SSRF guard/)
  })

  // The combination a deployed environment can reach by accident — a copied
  // .env, a quickstart compose file reused as a staging base — gets its own
  // louder message, because NETWORK=regtest is self-evidently local and this
  // is not.
  it("warns louder when the flag is set on a non-regtest network", () => {
    process.env.NETWORK = "mainnet"
    clearFlags()
    process.env[DEV_UNSAFE_MODE_FLAG] = "true"

    warnIfDevContext()

    const [message] = messages()
    expect(message).toMatch(/UNSAFE DEV MODE IS ON/)
    expect(message).toContain(DEV_UNSAFE_MODE_FLAG)
    expect(message).toMatch(/NETWORK=mainnet/)
    expect(message).toMatch(/SSRF/)
    expect(message).toMatch(/lnurl/)
  })

  it("names the deprecated flag and its replacement when that is what is set", () => {
    process.env.NETWORK = "mainnet"
    clearFlags()
    process.env[DEPRECATED_DEV_UNSAFE_MODE_FLAG] = "true"

    warnIfDevContext()

    const joined = messages().join("\n")
    expect(joined).toContain(DEPRECATED_DEV_UNSAFE_MODE_FLAG)
    expect(joined).toContain(DEV_UNSAFE_MODE_FLAG)
    expect(joined).toMatch(/deprecated/)
    // Still gets the loud unsafe-mode warning, not only the rename notice.
    expect(joined).toMatch(/UNSAFE DEV MODE IS ON/)
  })
})
