import { randomBytes } from "crypto"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import {
  loadKeyring,
  parseKeyring,
  tokenVault,
} from "@services/pos-usdt-checkout/token-vault"

const key = () => randomBytes(32).toString("base64")
const TOKEN = "ab".repeat(32)

it("seals a token so that only the same receipt and activity open it", () => {
  const vault = tokenVault(parseKeyring("k1:" + key()))
  const sealed = vault.seal(TOKEN, "aad-1")
  expect(sealed).not.toContain(TOKEN)
  expect(vault.seal(TOKEN, "aad-1")).not.toBe(sealed)
  expect(vault.open(sealed, "aad-1")).toBe(TOKEN)
  expect(() => vault.open(sealed, "aad-2")).toThrow("Sealed token cannot be opened.")
})

it("refuses tampered, truncated or foreign text with one message", () => {
  const vault = tokenVault(parseKeyring("k1:" + key()))
  const sealed = vault.seal(TOKEN, "a")
  const parts = sealed.split(".")
  const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1)
  for (const bad of [
    [parts[0], parts[1], parts[2], flip(parts[3]), parts[4]].join("."),
    [parts[0], parts[1], parts[2], parts[3], parts[4].slice(0, 8)].join("."),
    [parts[0], "k9", parts[2], parts[3], parts[4]].join("."),
    "v0." + parts.slice(1).join("."),
    "",
  ])
    expect(() => vault.open(bad, "a")).toThrow("Sealed token cannot be opened.")
  const other = tokenVault(parseKeyring("k1:" + key()))
  expect(() => other.open(sealed, "a")).toThrow("Sealed token cannot be opened.")
})

it("rotates keys: the first seals, every listed key opens", () => {
  const oldKey = key()
  const before = tokenVault(parseKeyring("k1:" + oldKey))
  const sealed = before.seal(TOKEN, "a")
  const after = tokenVault(parseKeyring(`k2:${key()},k1:${oldKey}`))
  expect(after.open(sealed, "a")).toBe(TOKEN)
  expect(after.seal(TOKEN, "a")).toMatch(/^v1\.k2\./)
})

it.each([
  ["empty", ""],
  ["no key id", ":" + key()],
  ["a short key", "k1:" + randomBytes(16).toString("base64")],
  ["a duplicate id", `k1:${key()},k1:${key()}`],
  ["not base64", "k1:not base64!"],
])("refuses a keyring with %s, without echoing it", (_label, text) => {
  let message = ""
  try {
    parseKeyring(text)
  } catch (err) {
    message = (err as Error).message
  }
  expect(message).toMatch(/keyring/i)
  const material = text.split(":")[1]
  const disclosedKey = Boolean(
    material && material.length > 8 && message.includes(material),
  )
  expect(disclosedKey).toBe(false)
})

describe("loading", () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pos-usdt-vault-"))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("reads a mounted keyring file that other users cannot read", () => {
    const file = join(dir, "keys")
    writeFileSync(file, "k1:" + key() + "\n")
    chmodSync(file, 0o640)
    expect(loadKeyring({ POS_USDT_LIVE_TOKEN_KEYS_FILE: file }).active).toBe("k1")
    chmodSync(file, 0o644)
    expect(() => loadKeyring({ POS_USDT_LIVE_TOKEN_KEYS_FILE: file })).toThrow(
      /other users/,
    )
  })

  it("refuses two sources at once", () => {
    expect(() =>
      loadKeyring({
        POS_USDT_LIVE_TOKEN_KEYS: "k1:" + key(),
        POS_USDT_LIVE_TOKEN_KEYS_FILE: "/x",
      }),
    ).toThrow(/not both/)
  })
})
