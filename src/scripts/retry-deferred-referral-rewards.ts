#!/usr/bin/env node

/**
 * Operator tool: replay referral rewards deferred by the ERPNext kill switch
 * (src/app/invite/referral-settings.ts). Run with --dry-run to see the
 * backlog size without paying anyone (e.g. right before flipping the switch
 * back on); omit --dry-run (default: false) to actually replay it. See
 * src/app/invite/retry-deferred-rewards.ts for why replaying is always safe
 * (the award hook is idempotent and fail-closed).
 *
 * Usage:
 *   node lib/scripts/retry-deferred-referral-rewards.js \
 *     --configPath dev/config/base-config.yaml \
 *     [--dry-run]
 */

import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { setupMongoConnection } from "@services/mongodb"
import { baseLogger } from "@services/logger"
import { retryDeferredReferralRewards } from "@app/invite/retry-deferred-rewards"

export const buildArgs = (argv: string[]) =>
  yargs(argv)
    .option("dry-run", {
      type: "boolean" as const,
      default: false,
      describe: "Report the backlog size without paying anyone (default: false)",
    })
    .option("configPath", { type: "string" as const, demandOption: true })
    .parseSync()

const main = async () => {
  const args = buildArgs(hideBin(process.argv))
  const dryRun = args["dry-run"]
  const result = await retryDeferredReferralRewards({ dryRun })
  baseLogger.info(
    { ...result, dryRun },
    dryRun
      ? "Referral reward backlog check finished (dry run, nothing paid)"
      : "Referral reward backlog replay finished",
  )
}

if (require.main === module) {
  setupMongoConnection()
    .then(async (mongoose) => {
      await main()
      await mongoose?.connection.close()
      process.exit(0)
    })
    .catch((error) => {
      baseLogger.error({ error }, "Referral reward backlog replay failed")
      process.exit(1)
    })
}
