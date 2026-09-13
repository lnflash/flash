import { NETWORK } from "@config"

/**
 * Environment stamp for every outbound alert. A test-cluster probe and a prod
 * outage used to render identically in Discord (same source, same severity,
 * same title), so the reader had no way to tell which cluster was paging them.
 * Every sender now carries a loud PROD/TEST tag, derived from the Bitcoin
 * network the process runs against: mainnet is the only production network,
 * anything else (signet/testnet/regtest) is a test environment.
 */
export type AlertEnvTag = "PROD" | "TEST" | "UNKNOWN"

// Raw network name (or NODE_ENV as a fallback outside the config-driven
// runtime) — used as a plain "env" field where the reader wants the detail.
export const envLabel = (): string => NETWORK ?? process.env.NODE_ENV ?? "unknown"

export const envTag = (): AlertEnvTag => {
  if (!NETWORK) return "UNKNOWN"
  return NETWORK === "mainnet" ? "PROD" : "TEST"
}

// "[TEST]" / "[PROD]" — prepended to titles so the tag survives every
// destination's own truncation and is the first thing a reader sees.
export const envTagPrefix = (): string => `[${envTag()}]`

// "PROD (mainnet)" / "TEST (signet)" — the field-value form.
export const envSummary = (): string => `${envTag()} (${envLabel()})`
