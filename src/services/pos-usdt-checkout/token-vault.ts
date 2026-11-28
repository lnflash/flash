import { createCipheriv, createDecipheriv, randomBytes } from "crypto"
import { readFileSync, statSync } from "fs"

import type { Vault } from "@app/pos-usdt-checkout/live-updates"

/**
 * Seals ActivityKit push tokens at rest with AES-256-GCM.
 *
 * The keyring is operator-provided, never generated or logged here:
 *
 *   POS_USDT_LIVE_TOKEN_KEYS       "kid:base64key[,kid:base64key...]"
 *   POS_USDT_LIVE_TOKEN_KEYS_FILE  a file holding the same text (a mounted
 *                                  secret); not readable by "other"
 *
 * Each key is 32 random bytes. The first entry seals; every entry opens, so a
 * key is rotated by putting the new one first and dropping the old one after
 * the longest follow window plus retention (about a day). Sealed text names
 * its key id, never the key. The caller's AAD binds a token to one receipt
 * and one activity.
 */

const KID = /^[A-Za-z0-9_-]{1,32}$/
const VERSION = "v1"

export class VaultConfigError extends Error {}

export type Keyring = { active: string; keys: Map<string, Buffer> }

export function parseKeyring(text: string): Keyring {
  const keys = new Map<string, Buffer>()
  let active: string | undefined
  for (const entry of text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    const at = entry.indexOf(":")
    const kid = entry.slice(0, at)
    const material = entry.slice(at + 1)
    if (at < 1 || !KID.test(kid) || keys.has(kid))
      throw new VaultConfigError("Token keyring: each entry needs a unique key id.")
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(material))
      throw new VaultConfigError(`Token keyring: key ${kid} is not base64.`)
    const key = Buffer.from(material, "base64")
    if (key.length !== 32)
      throw new VaultConfigError(`Token keyring: key ${kid} must be 32 bytes.`)
    keys.set(kid, key)
    active ??= kid
  }
  if (!active) throw new VaultConfigError("Token keyring is empty.")
  return { active, keys }
}

export function loadKeyring(env: NodeJS.ProcessEnv = process.env): Keyring {
  const file = (env.POS_USDT_LIVE_TOKEN_KEYS_FILE || "").trim()
  const inline = env.POS_USDT_LIVE_TOKEN_KEYS || ""
  if (file && inline.trim())
    throw new VaultConfigError("Set POS_USDT_LIVE_TOKEN_KEYS or its _FILE, not both.")
  if (file) {
    const stat = statSync(file)
    if (!stat.isFile() || stat.mode & 0o007)
      throw new VaultConfigError(
        "Token keyring file must not be readable by other users.",
      )
    return parseKeyring(readFileSync(file, "utf8"))
  }
  return parseKeyring(inline)
}

const b64 = (b: Buffer) => b.toString("base64url")

export function tokenVault(ring: Keyring): Vault {
  return {
    seal(plain, aad) {
      const key = ring.keys.get(ring.active) as Buffer
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key, iv)
      cipher.setAAD(Buffer.from(aad, "utf8"))
      const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
      return [VERSION, ring.active, b64(iv), b64(body), b64(cipher.getAuthTag())].join(
        ".",
      )
    },
    open(sealed, aad) {
      const parts = typeof sealed === "string" ? sealed.split(".") : []
      const [version, kid, iv, body, tag] = parts
      const key = kid ? ring.keys.get(kid) : undefined
      // One message for every failure: nothing about the token or key leaks.
      if (parts.length !== 5 || version !== VERSION || !key)
        throw new Error("Sealed token cannot be opened.")
      try {
        const nonce = Buffer.from(iv, "base64url")
        const authTag = Buffer.from(tag, "base64url")
        // A truncated tag would weaken the check.
        if (nonce.length !== 12 || authTag.length !== 16) throw new Error("shape")
        const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
          authTagLength: 16,
        })
        decipher.setAAD(Buffer.from(aad, "utf8"))
        decipher.setAuthTag(authTag)
        return Buffer.concat([
          decipher.update(Buffer.from(body, "base64url")),
          decipher.final(),
        ]).toString("utf8")
      } catch {
        throw new Error("Sealed token cannot be opened.")
      }
    },
  }
}
