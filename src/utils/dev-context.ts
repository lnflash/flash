import { baseLogger } from "@services/logger"

// Is this process running as a local/dev stack rather than a deployed one?
//
// Two signals, because neither alone covers the ways we run locally:
//   - NETWORK=regtest — a self-contained regtest stack.
//   - FLASH_DEV_UNSAFE_MODE=true — the explicit opt-in the repo's own dev
//     stack sets in .env. It runs NETWORK=mainnet against the Ibex sandbox, so
//     NETWORK alone can't mark it as dev.
//
// The flag is named for its blast radius rather than for one consumer, because
// it is much more than "let the repo's committed secrets authenticate" (its
// former name, ALLOW_REPO_DEV_SECRETS, promised only that). Every guard with a
// "dev stacks keep working" escape hatch reads THIS predicate, so setting it
// ALSO disables the entire SSRF guard on every URL the server fetches on a
// user's behalf — `GET /pay/lnurl/:username` (public and unauthenticated) and
// the `lnurlPaymentSend` mutation: https-only, the cloud-metadata hostname
// denylist, the private-IP-literal check, and both the pre-flight and
// connect-time DNS checks all go away. A shared or staging box with this set
// is an SSRF proxy into whatever network it sits in, on top of authenticating
// anyone who has read this public repo.
//
// Deployed environments must never set it, and warnIfDevContext() below says
// so out loud at boot so the state is never silent.
//
// Read at call time, not import time, so tests can flip it.
export const DEV_UNSAFE_MODE_FLAG = "FLASH_DEV_UNSAFE_MODE"

// Deprecated alias kept for one release so an existing local .env / compose
// file does not break on upgrade. Remove it after the next release; the boot
// warning below tells anyone still on it to rename.
export const DEPRECATED_DEV_UNSAFE_MODE_FLAG = "ALLOW_REPO_DEV_SECRETS"

// Which flag (if any) turned unsafe mode on — the name matters for the
// deprecation notice, so this returns it rather than a boolean.
const unsafeModeFlag = (): string | null => {
  if (process.env[DEV_UNSAFE_MODE_FLAG] === "true") return DEV_UNSAFE_MODE_FLAG
  if (process.env[DEPRECATED_DEV_UNSAFE_MODE_FLAG] === "true") {
    return DEPRECATED_DEV_UNSAFE_MODE_FLAG
  }
  return null
}

export const isDevContext = (): boolean =>
  process.env.NETWORK === "regtest" || unsafeModeFlag() !== null

// Boot-time announcement. Call this from every server entrypoint whose
// surfaces have a dev escape hatch (the api, the ibex webhook server, the
// bridge webhook server): a process running with the guards off must say so in
// its own logs, not only in whatever config file happened to set the flag.
//
// The flag-set-while-NETWORK-is-not-regtest combination gets its own, louder
// message: NETWORK=regtest is self-evidently a local stack, while the flag is
// the only one of the two signals a deployed environment can reach by accident
// (a copied .env, a quickstart compose file used as the base for a staging
// box).
export const warnIfDevContext = (): void => {
  const flag = unsafeModeFlag()
  const network = process.env.NETWORK ?? null

  if (flag === DEPRECATED_DEV_UNSAFE_MODE_FLAG) {
    baseLogger.warn(
      { flag, replacement: DEV_UNSAFE_MODE_FLAG },
      `${DEPRECATED_DEV_UNSAFE_MODE_FLAG} is deprecated — rename it to ` +
        `${DEV_UNSAFE_MODE_FLAG}. The old name stops being honoured next release.`,
    )
  }

  if (flag !== null && network !== "regtest") {
    baseLogger.warn(
      { flag, network },
      `UNSAFE DEV MODE IS ON: ${flag}=true with NETWORK=${network ?? "unset"}. ` +
        `This process accepts the auth secrets committed to the public flash ` +
        `repo AND runs with the SSRF guard disabled — the public, ` +
        `unauthenticated GET /pay/lnurl/:username will fetch http:// URLs, ` +
        `loopback/private addresses and cloud-metadata hostnames on behalf of ` +
        `any caller. Never set this outside a local dev stack.`,
    )
    return
  }

  if (isDevContext()) {
    baseLogger.warn(
      { flag, network },
      `Dev context (NETWORK=regtest): the committed repo secrets authenticate ` +
        `and the SSRF guard on GET /pay/lnurl/:username is disabled.`,
    )
  }
}
