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
 *     [--dry-run] \
 *     [--account <accountId> | --username <username>] \
 *     [--inviter <accountId>]
 *
 * --account / --username replay only that invitee's deferred reward;
 * --inviter replays only invites sent by that account. Use them for the
 * Referral Payout Allowlist (src/app/invite/referral-payout-allowlist.ts):
 *   1. fund the rewards wallet FIRST (an underfunded payout is recorded as
 *      "partial" and needs manual reconciliation);
 *   2. dry-run with --username <name> --dry-run and check the logged
 *      backlogCount and allowlisted=true;
 *   3. execute the same command without --dry-run.
 */

import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { checkedToAccountId } from "@domain/accounts"
import { setupMongoConnection } from "@services/mongodb"
import { AccountsRepository } from "@services/mongoose"
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
    .option("account", {
      type: "string" as const,
      describe: "Only retry this invitee account id",
    })
    .option("username", {
      type: "string" as const,
      describe: "Only retry this invitee username (resolved to its account id)",
    })
    .option("inviter", {
      type: "string" as const,
      describe: "Only retry invites sent by this inviter account id",
    })
    .conflicts("account", "username")
    .parseSync()

const toAccountIdOrThrow = (raw: string, flag: string): AccountId => {
  const accountId = checkedToAccountId(raw.trim())
  if (accountId instanceof Error) throw new Error(`--${flag} is not a valid account id`)
  return accountId
}

export const resolveFilters = async (args: {
  account?: string
  username?: string
  inviter?: string
}): Promise<{ account?: AccountId; inviter?: AccountId }> => {
  let account: AccountId | undefined
  if (args.account !== undefined) account = toAccountIdOrThrow(args.account, "account")
  if (args.username !== undefined) {
    const found = await AccountsRepository().findByUsername(
      args.username.trim() as Username,
    )
    if (found instanceof Error)
      throw new Error(`--username ${args.username} not found: ${found.name}`)
    account = found.id
  }
  const inviter =
    args.inviter !== undefined ? toAccountIdOrThrow(args.inviter, "inviter") : undefined
  return { account, inviter }
}

const main = async () => {
  const args = buildArgs(hideBin(process.argv))
  const dryRun = args["dry-run"]
  const { account, inviter } = await resolveFilters(args)
  const result = await retryDeferredReferralRewards({ dryRun, account, inviter })
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
