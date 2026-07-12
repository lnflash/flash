import { ApiKeyModel } from "@services/mongoose/api-keys"

const validFields = {
  keyId: "a1b2c3d4",
  accountId: "account-id",
  name: "BTCPay Server",
  hashedKey: "f".repeat(64),
  scopes: ["read:wallet"],
}

describe("ApiKeyModel schema", () => {
  it("accepts a valid document and applies defaults", () => {
    const doc = new ApiKeyModel(validFields)

    expect(doc.validateSync()).toBeUndefined()
    expect(doc.status).toBe("active")
    expect(doc.ipConstraints).toEqual([])
    expect(doc.lastUsedAt).toBeNull()
    expect(doc.expiresAt).toBeNull()
    expect(doc.createdAt).toBeInstanceOf(Date)
  })

  it("requires keyId, name, and hashedKey", () => {
    for (const missing of ["keyId", "name", "hashedKey"] as const) {
      const fields: Record<string, unknown> = { ...validFields }
      delete fields[missing]
      const err = new ApiKeyModel(fields).validateSync()
      expect(err?.errors[missing]).toBeDefined()
    }
  })

  it("requires at least one scope", () => {
    expect(
      new ApiKeyModel({ ...validFields, scopes: [] }).validateSync()?.errors.scopes,
    ).toBeDefined()
    expect(
      new ApiKeyModel({ ...validFields, scopes: undefined }).validateSync()?.errors
        .scopes,
    ).toBeDefined()
  })

  it("rejects scopes outside the FIP-07 enum", () => {
    const err = new ApiKeyModel({
      ...validFields,
      scopes: ["read:everything"],
    }).validateSync()
    expect(err).toBeDefined()
  })

  it("rejects an unknown status", () => {
    const err = new ApiKeyModel({ ...validFields, status: "paused" }).validateSync()
    expect(err?.errors.status).toBeDefined()
  })
})
