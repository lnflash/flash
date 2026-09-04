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
