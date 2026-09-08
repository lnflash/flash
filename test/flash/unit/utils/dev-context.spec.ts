import { isDevContext } from "@utils/dev-context"

// One predicate, two consumers: the weak-secret refusal and the SSRF guard.
// Before this existed they disagreed — the SSRF guard keyed only on
// NETWORK=regtest while the local dev stack runs NETWORK=mainnet with
// ALLOW_REPO_DEV_SECRETS=true, so a developer with a localhost lnurlp got a
// 502 and a comment claiming regtest covered them.
describe("isDevContext", () => {
  const savedNetwork = process.env.NETWORK
  const savedAllow = process.env.ALLOW_REPO_DEV_SECRETS

  afterEach(() => {
    if (savedNetwork === undefined) delete process.env.NETWORK
    else process.env.NETWORK = savedNetwork
    if (savedAllow === undefined) delete process.env.ALLOW_REPO_DEV_SECRETS
    else process.env.ALLOW_REPO_DEV_SECRETS = savedAllow
  })

  it("is true on regtest", () => {
    process.env.NETWORK = "regtest"
    delete process.env.ALLOW_REPO_DEV_SECRETS
    expect(isDevContext()).toBe(true)
  })

  it("is true on mainnet with the explicit opt-in (the repo's own dev stack)", () => {
    process.env.NETWORK = "mainnet"
    process.env.ALLOW_REPO_DEV_SECRETS = "true"
    expect(isDevContext()).toBe(true)
  })

  it("is false for a deployed environment", () => {
    process.env.NETWORK = "mainnet"
    delete process.env.ALLOW_REPO_DEV_SECRETS
    expect(isDevContext()).toBe(false)

    process.env.NETWORK = "signet"
    expect(isDevContext()).toBe(false)
  })

  it("only accepts the exact opt-in value", () => {
    process.env.NETWORK = "mainnet"
    for (const value of ["1", "yes", "TRUE", ""]) {
      process.env.ALLOW_REPO_DEV_SECRETS = value
      expect(isDevContext()).toBe(false)
    }
  })

  it("is read at call time, not import time", () => {
    process.env.NETWORK = "mainnet"
    delete process.env.ALLOW_REPO_DEV_SECRETS
    expect(isDevContext()).toBe(false)
    process.env.NETWORK = "regtest"
    expect(isDevContext()).toBe(true)
  })
})
