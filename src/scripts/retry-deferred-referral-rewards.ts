#!/usr/bin/env node

/**
 * Operator tool: replay referral rewards deferred by the ERPNext kill switch
 * (src/app/invite/referral-settings.ts). Run with --dry-run right before
 * flipping the switch back on to see the backlog size; drop --dry-run to
 * actually replay it. See src/app/invite/retry-deferred-rewards.ts for why
 * replaying is always safe (the award hook is idempotent and fail-closed).
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

const args = yargs(hideBin(process.argv))
  .option("dry-run", {
    type: "boolean",
    default: true,
    describe: "Report the backlog size without paying anyone (default: true)",
  })
  .option("configPath", { type: "string", demandOption: true })
  .parseSync()

const main = async () => {
  const dryRun = args["dry-run"]
  const result = await retryDeferredReferralRewards({ dryRun })
  baseLogger.info(
    { ...result, dryRun },
    dryRun
      ? "Referral reward backlog check finished (dry run, nothing paid)"
      : "Referral reward backlog replay finished",
  )
}

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
