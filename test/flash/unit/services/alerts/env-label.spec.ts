const mockNetwork = { value: "mainnet" as string | undefined }
jest.mock("@config", () => ({
  get NETWORK() {
    return mockNetwork.value
  },
}))

import { envLabel, envSummary, envTag, envTagPrefix } from "@services/alerts/env-label"

describe("alert env label", () => {
  const originalNodeEnv = process.env.NODE_ENV

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
  })

  it("tags mainnet as PROD", () => {
    mockNetwork.value = "mainnet"
    expect(envTag()).toBe("PROD")
    expect(envTagPrefix()).toBe("[PROD]")
    expect(envSummary()).toBe("PROD (mainnet)")
  })

  it.each(["signet", "testnet", "regtest"])("tags %s as TEST", (network) => {
    mockNetwork.value = network
    expect(envTag()).toBe("TEST")
    expect(envTagPrefix()).toBe("[TEST]")
    expect(envSummary()).toBe(`TEST (${network})`)
  })

  it("never reports PROD when the network is unset", () => {
    mockNetwork.value = undefined
    process.env.NODE_ENV = "production"
    expect(envTag()).toBe("UNKNOWN")
    // The raw label still falls back to NODE_ENV for the detail field.
    expect(envLabel()).toBe("production")
    expect(envSummary()).toBe("UNKNOWN (production)")
  })

  it("falls back to 'unknown' when neither NETWORK nor NODE_ENV is set", () => {
    mockNetwork.value = undefined
    delete process.env.NODE_ENV
    expect(envLabel()).toBe("unknown")
    expect(envSummary()).toBe("UNKNOWN (unknown)")
  })
})
