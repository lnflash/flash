import { configSchema } from "../../../../src/config/schema"

describe("config schema", () => {
  it("requires bridge developerFeePercent without a hardcoded default", () => {
    const bridgeSchema = configSchema.properties.bridge

    expect(bridgeSchema.properties.developerFeePercent).toEqual({ type: "number" })
    expect(bridgeSchema.required).toContain("developerFeePercent")
  })
})
