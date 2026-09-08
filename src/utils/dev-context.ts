// Is this process running as a local/dev stack rather than a deployed one?
//
// Two signals, because neither alone covers the ways we run locally:
//   - NETWORK=regtest — a self-contained regtest stack.
//   - ALLOW_REPO_DEV_SECRETS=true — the explicit opt-in the repo's own dev
//     stack sets in .env. It runs NETWORK=mainnet against the Ibex sandbox, so
//     NETWORK alone can't mark it as dev.
//
// Deployed environments must never set the flag. Every guard that has a "dev
// stacks keep working" escape hatch (the weak-secret refusal, the SSRF guard's
// http/loopback allowance) reads THIS predicate, so there is exactly one
// answer to "am I in a dev context" in the codebase.
//
// Read at call time, not import time, so tests can flip it.
export const isDevContext = (): boolean =>
  process.env.NETWORK === "regtest" || process.env.ALLOW_REPO_DEV_SECRETS === "true"
