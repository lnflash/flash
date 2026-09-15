import { IbexConfig } from "@config"

/**
 * Environment stamp for every outbound alert. A test-cluster probe and a prod
 * outage used to render identically in Discord (same source, same severity,
 * same title), so the reader had no way to tell which cluster was paging them.
 *
 * The tag is derived from the IBEX environment the process is wired to, NOT
 * from the Bitcoin network. `NETWORK` is the wrong signal for this fleet: the
 * TEST cluster runs NETWORK=mainnet too (the flash chart defaults
 * `galoy.network: mainnet` and neither cluster overrides it — see
 * src/utils/dev-context.ts for the same caveat on the dev stack), so a
 * network-based tag would have labelled every TEST alert as PROD.
 *
 * `ibex.environment` is the one config value that actually differs between
 * the clusters: the chart default is `sandbox` (TEST, and the local dev stack
 * in dev/config/base-config.yaml), and PROD must override it to `production`
 * or every IBEX call 401s against the sandbox auth domain. It is therefore
 * both cluster-specific and self-verifying — a prod deploy with the wrong
 * value would not be serving payments.
 */
export type AlertEnvTag = "PROD" | "TEST" | "UNKNOWN"

// The raw signal the tag is derived from. Read at call time, not import
// time, so tests can flip it. The yaml schema (src/config/schema.ts) declares
// `environment` as an enum but neither requires it nor defaults it, so a
// process can boot with it unset — and ibex-client then silently falls back
// to the PRODUCTION hub. That is a misconfiguration, not a known
// environment, so it is reported as such rather than guessed either way.
const ibexEnvironment = (): string | undefined => IbexConfig?.environment

export const envTag = (): AlertEnvTag => {
  const environment = ibexEnvironment()
  if (environment === "production") return "PROD"
  if (environment === "sandbox") return "TEST"
  return "UNKNOWN"
}

// "ibex:production" / "ibex:sandbox" / "ibex:unset" — the signal the tag was
// derived from, named so a reader can tell at a glance what to fix if the
// tag looks wrong.
export const envLabel = (): string => `ibex:${ibexEnvironment() ?? "unset"}`

// "[TEST]" / "[PROD]" — prepended to titles so the tag survives every
// destination's own truncation and is the first thing a reader sees.
export const envTagPrefix = (): string => `[${envTag()}]`

// "PROD (ibex:production)" / "TEST (ibex:sandbox)" — the field-value form.
export const envSummary = (): string => `${envTag()} (${envLabel()})`
