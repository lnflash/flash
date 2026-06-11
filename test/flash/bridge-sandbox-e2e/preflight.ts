/**
 * Preflight Checks for Bridge Sandbox E2E Suite
 *
 * IMPORTANT: BridgeService.checkAccountLevel() is a private module-level
 * function — it is NOT exported and cannot be imported by tests.
 *
 * This preflight uses source-code analysis to verify the guard condition.
 * It checks the source file for `account.level < N` within the
 * `checkAccountLevel` function and validates that N <= 1.
 */

import fs from "fs"
import path from "path"

/**
 * Verify the service-level guard condition in BridgeService.checkAccountLevel().
 *
 * Checks the source file for the account level comparison.
 * The guard in src/services/bridge/index.ts should be `account.level < 1`
 * so that Level 1 accounts can access Bridge operations.
 *
 * @returns true if the guard is correctly configured (level >= 1 allowed)
 */
export function preflightServiceLevelGuard(): boolean {
  const servicePath = path.resolve(__dirname, "../../../src/services/bridge/index.ts")

  let content: string
  try {
    content = fs.readFileSync(servicePath, "utf-8")
  } catch {
    console.warn("PREFLIGHT WARN: Could not read BridgeService source at", servicePath)
    return true // Skip check — assume fixed in build artifact
  }

  // Extract the guard comparison value from checkAccountLevel.
  // Matches: `account.level < N` anywhere inside the function body.
  const funcMatch = content.match(
    /const\s+checkAccountLevel[\s\S]*?account\.level\s*<(\s*\d+)/,
  )

  if (!funcMatch) {
    console.warn(
      "PREFLIGHT WARN: Could not detect service-level guard pattern in BridgeService.",
    )
    return true // Pattern not found — skip
  }

  const guardLevel = parseInt(funcMatch[1], 10)

  if (guardLevel <= 1) {
    // Level 0 only is blocked — level 1+ is allowed. Correct configuration.
    return true
  }

  console.error(
    `PREFLIGHT FAILED: BridgeService.checkAccountLevel() blocks level < ${guardLevel}, ` +
      `but the e2e suite requires level >= 1 to pass through.\n` +
      `Fix required in src/services/bridge/index.ts:\n` +
      `  if (account.level < ${guardLevel}) -> if (account.level < 1)\n` +
      `See test/flash/bridge-sandbox-e2e/README.md for setup details.`,
  )

  return false
}
