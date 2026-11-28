import { createPublicKey, KeyObject } from "crypto"

import { IbexConfig } from "@config"

// DER prefix that wraps a raw 32-byte Ed25519 public key as SPKI.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")

// The webhook's public key, or undefined when the config value is not a raw
// 32-byte Ed25519 key in base64.
export const parseHubPublicKey = (publicKeyB64: string): KeyObject | undefined => {
  const raw = Buffer.from(publicKeyB64.trim(), "base64")
  if (raw.length !== 32) return undefined
  try {
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    })
  } catch {
    return undefined
  }
}

export const hubPublicKey = parseHubPublicKey(IbexConfig.webhook.hub?.publicKey ?? "")
