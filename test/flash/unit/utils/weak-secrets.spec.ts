import { assertStrongSecret, isWeakSecret, WeakSecretError } from "@utils/weak-secrets"

describe("isWeakSecret", () => {
  it("treats unset and blank secrets as weak", () => {
    for (const secret of [undefined, null, "", "   "]) {
      expect(isWeakSecret(secret)).toBe(true)
    }
  })

  it("flags every known-public placeholder", () => {
    for (const secret of [
      "not-so-secret",
      "also-not-so-secret",
      "change-me",
      "<replace>",
    ]) {
      expect(isWeakSecret(secret)).toBe(true)
    }
  })

  it("flags placeholders with surrounding whitespace", () => {
    expect(isWeakSecret("  not-so-secret  ")).toBe(true)
  })

  it("accepts real secrets", () => {
    expect(isWeakSecret("Kramerica")).toBe(false)
    expect(isWeakSecret("0a1cb6ba85cda40291e3ca4f2a777041cc59b48b")).toBe(false)
  })
})

describe("committed dev-only values", () => {
  // The rotated values committed in .env and dev/config/base-config.yaml —
  // random-looking but publicly known, so refused outside a dev context.
  const DEV_VALUES = [
    "0a1cb6ba85cda40291e3ca4f2a777041cc59b48ba9fac2488e0bf752340c4588",
    "7189c07e9a60977492c9471a527b0d9040c1fa3c5b7bfd7e87e58db018160ddb",
  ]

  const savedNetwork = process.env.NETWORK
  const savedAllow = process.env.ALLOW_REPO_DEV_SECRETS

  afterEach(() => {
    if (savedNetwork === undefined) delete process.env.NETWORK
    else process.env.NETWORK = savedNetwork
    if (savedAllow === undefined) delete process.env.ALLOW_REPO_DEV_SECRETS
    else process.env.ALLOW_REPO_DEV_SECRETS = savedAllow
  })

  it("refuses them on non-regtest networks without the dev flag", () => {
    process.env.NETWORK = "mainnet"
    delete process.env.ALLOW_REPO_DEV_SECRETS
    for (const secret of DEV_VALUES) {
      expect(isWeakSecret(secret)).toBe(true)
    }
    expect(() => assertStrongSecret("ERPNEXT_JWT_SECRET", DEV_VALUES[0])).toThrow(
      WeakSecretError,
    )
  })

  it("accepts them on regtest", () => {
    process.env.NETWORK = "regtest"
    delete process.env.ALLOW_REPO_DEV_SECRETS
    for (const secret of DEV_VALUES) {
      expect(isWeakSecret(secret)).toBe(false)
    }
  })

  it("accepts them with the explicit dev flag (local dev stack)", () => {
    process.env.NETWORK = "mainnet"
    process.env.ALLOW_REPO_DEV_SECRETS = "true"
    for (const secret of DEV_VALUES) {
      expect(isWeakSecret(secret)).toBe(false)
    }
  })
})

describe("assertStrongSecret", () => {
  it("throws WeakSecretError naming the variable for weak values", () => {
    for (const secret of [undefined, "", "not-so-secret"]) {
      expect(() => assertStrongSecret("ERPNEXT_JWT_SECRET", secret)).toThrow(
        WeakSecretError,
      )
      expect(() => assertStrongSecret("ERPNEXT_JWT_SECRET", secret)).toThrow(
        /ERPNEXT_JWT_SECRET/,
      )
    }
  })

  it("passes for a strong secret", () => {
    expect(() =>
      assertStrongSecret("ERPNEXT_JWT_SECRET", "actual-random-hex-value"),
    ).not.toThrow()
  })
})
