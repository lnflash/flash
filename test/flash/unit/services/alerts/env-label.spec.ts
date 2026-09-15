// The tag must come from the IBEX environment, never from NETWORK: both
// clusters run NETWORK=mainnet (chart default, not overridden), so the mock
// exposes BOTH values and the tests pin that NETWORK is ignored.
const mockConfig = {
  ibexEnvironment: "sandbox" as string | undefined,
  network: "mainnet" as string,
}
jest.mock("@config", () => ({
  get IbexConfig() {
    return { environment: mockConfig.ibexEnvironment }
  },
  get NETWORK() {
    return mockConfig.network
  },
}))

import { envLabel, envSummary, envTag, envTagPrefix } from "@services/alerts/env-label"

describe("alert env label", () => {
  const originalNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    mockConfig.ibexEnvironment = "sandbox"
    mockConfig.network = "mainnet"
  })

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
  })

  it("tags ibex production as PROD", () => {
    mockConfig.ibexEnvironment = "production"
    expect(envTag()).toBe("PROD")
    expect(envTagPrefix()).toBe("[PROD]")
    expect(envLabel()).toBe("ibex:production")
    expect(envSummary()).toBe("PROD (ibex:production)")
  })

  it("tags ibex sandbox as TEST", () => {
    mockConfig.ibexEnvironment = "sandbox"
    expect(envTag()).toBe("TEST")
    expect(envTagPrefix()).toBe("[TEST]")
    expect(envLabel()).toBe("ibex:sandbox")
    expect(envSummary()).toBe("TEST (ibex:sandbox)")
  })

  // Regression: the TEST cluster is NETWORK=mainnet + ibex sandbox (the flash
  // chart defaults galoy.network to mainnet and the test values file does not
  // override it). A network-derived tag rendered every TEST alert as PROD.
  it("tags the real TEST cluster shape (NETWORK=mainnet, ibex sandbox) as TEST, not PROD", () => {
    mockConfig.network = "mainnet"
    mockConfig.ibexEnvironment = "sandbox"
    expect(envTag()).toBe("TEST")
    expect(envSummary()).toBe("TEST (ibex:sandbox)")
    expect(envSummary()).not.toContain("mainnet")
  })

  it.each(["mainnet", "signet", "testnet", "regtest"])(
    "ignores NETWORK=%s entirely — only the ibex environment decides",
    (network) => {
      mockConfig.network = network
      mockConfig.ibexEnvironment = "production"
      expect(envTag()).toBe("PROD")
      mockConfig.ibexEnvironment = "sandbox"
      expect(envTag()).toBe("TEST")
    },
  )

  // The yaml schema does not require or default ibex.environment, so a
  // misconfigured process can boot with it unset. That must never read as a
  // confident PROD or TEST claim.
  it("reports UNKNOWN when the ibex environment is unset, regardless of NODE_ENV", () => {
    mockConfig.ibexEnvironment = undefined
    process.env.NODE_ENV = "production"
    expect(envTag()).toBe("UNKNOWN")
    expect(envTagPrefix()).toBe("[UNKNOWN]")
    expect(envLabel()).toBe("ibex:unset")
    expect(envSummary()).toBe("UNKNOWN (ibex:unset)")
  })

  it("reports UNKNOWN for an unrecognised ibex environment value", () => {
    mockConfig.ibexEnvironment = "staging"
    expect(envTag()).toBe("UNKNOWN")
    expect(envSummary()).toBe("UNKNOWN (ibex:staging)")
  })
})
