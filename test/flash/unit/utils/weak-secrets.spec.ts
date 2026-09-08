import {
  assertStrongSecret,
  isWeakSecret,
  MIN_SECRET_LENGTH,
  WeakSecretError,
} from "@utils/weak-secrets"
import { DEV_UNSAFE_MODE_FLAG } from "@utils/dev-context"

import {
  clearDevUnsafeModeFlags,
  restoreDevUnsafeModeFlags,
} from "test/flash/helpers/dev-context-env"

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
    expect(isWeakSecret("Kramerica-Industries-Latex-Salesman")).toBe(false)
    expect(isWeakSecret("0a1cb6ba85cda40291e3ca4f2a777041cc59b48b")).toBe(false)
  })

  // A denylist only catches the placeholders someone thought to list. A
  // 1-char ERPNEXT_JWT_SECRET is not on any list and is recoverable offline
  // from a single issued admin JWT — full admin-API takeover, reported by the
  // guard as a correctly configured deployment.
  it("flags secrets below the length floor, however random they look", () => {
    for (const secret of ["x", "hunter2", "a1b2c3d4", "0a1cb6ba85cda40291e3ca4f"]) {
      expect(isWeakSecret(secret)).toBe(true)
    }
    // 31 chars is refused, 32 is not.
    expect(isWeakSecret("a".repeat(31))).toBe(true)
    expect(isWeakSecret("a".repeat(32))).toBe(false)
  })

  // src/config/env.ts reuses this constant so a short ERPNEXT_JWT_SECRET is
  // refused at config load as well as at the admin server's boot guard. The
  // two must not be able to drift apart.
  it("exports the floor it enforces", () => {
    expect(MIN_SECRET_LENGTH).toBe(32)
    expect(isWeakSecret("a".repeat(MIN_SECRET_LENGTH - 1))).toBe(true)
    expect(isWeakSecret("a".repeat(MIN_SECRET_LENGTH))).toBe(false)
  })

  it("measures the trimmed length, not the padded one", () => {
    expect(isWeakSecret(`   ${"a".repeat(20)}   `)).toBe(true)
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

  afterEach(() => {
    if (savedNetwork === undefined) delete process.env.NETWORK
    else process.env.NETWORK = savedNetwork
    restoreDevUnsafeModeFlags()
  })

  it("refuses them on non-regtest networks without the dev flag", () => {
    process.env.NETWORK = "mainnet"
    clearDevUnsafeModeFlags()
    for (const secret of DEV_VALUES) {
      expect(isWeakSecret(secret)).toBe(true)
    }
    expect(() => assertStrongSecret("ERPNEXT_JWT_SECRET", DEV_VALUES[0])).toThrow(
      WeakSecretError,
    )
  })

  it("accepts them on regtest", () => {
    process.env.NETWORK = "regtest"
    clearDevUnsafeModeFlags()
    for (const secret of DEV_VALUES) {
      expect(isWeakSecret(secret)).toBe(false)
    }
  })

  it("accepts them with the explicit dev flag (local dev stack)", () => {
    process.env.NETWORK = "mainnet"
    clearDevUnsafeModeFlags()
    process.env[DEV_UNSAFE_MODE_FLAG] = "true"
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

  it("throws for a short secret and says why", () => {
    expect(() => assertStrongSecret("ERPNEXT_JWT_SECRET", "x")).toThrow(WeakSecretError)
    expect(() => assertStrongSecret("ERPNEXT_JWT_SECRET", "x")).toThrow(/too short/)
  })

  it("passes for a strong secret", () => {
    // 64 hex chars — what `openssl rand -hex 32` produces, and what the error
    // message tells operators to use.
    expect(() =>
      assertStrongSecret(
        "ERPNEXT_JWT_SECRET",
        "d3f9a1c85b2e47ad9c06f1b8e5427ac31f0d6b9e84c27a5f0b93e1d6c48a7b02",
      ),
    ).not.toThrow()
  })
})
