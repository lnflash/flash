#!/usr/bin/env node
// One-off (TEST): bootstrap the referral-rewards funding account.
// 1. Renames the closed legacy `rewards` account -> `rewards_old`.
// 2. Creates a fresh account username `rewards`, role `rewards`, active,
//    with real IBEX-provisioned USD + USDT wallets (USDT = default), mirroring
//    how prod's rewards account is shaped for the payout path
//    (award-referral-reward.ts funds USDT-first, falls back to USD).
// Account is payout-only: no kratos identity (kratosUserId is sparse), it can
// never log in. Idempotent-ish; dry-run unless --apply.
//
// Run inside the TEST api pod (compiled file cp'd into /app/lib/scripts/):
//   node lib/scripts/setup-rewards-account.js -c /var/yaml/custom.yaml [--apply]
import { addWalletIfNonexistent } from "@app/accounts"
import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import { Account } from "@services/mongoose/schema"
import { setupMongoConnection } from "@services/mongodb"

const apply = process.argv.includes("--apply")

const OLD_REWARDS_ACCOUNT_ID = "684c3e6613a5eac3da72e9ba" // closed 2025-06-13

const run = async () => {
  // 1. Rename the closed legacy holder so the username frees up.
  const old = await Account.findOne({ _id: OLD_REWARDS_ACCOUNT_ID })
  const oldPlan = old
    ? { id: String(old._id), username: old.username, renameTo: "rewards_old" }
    : { note: "old account not found (already renamed?)" }

  // Guard: after the rename, no other account may hold `rewards`.
  const conflict = await Account.findOne({
    username: "rewards",
    _id: { $ne: OLD_REWARDS_ACCOUNT_ID },
  })
  if (conflict) {
    throw new Error(`username 'rewards' already held by ${String(conflict._id)}`)
  }

  if (!apply) {
    console.log(
      JSON.stringify(
        { apply, oldPlan, plan: "rename old; create fresh active role=rewards account with USD+USDT wallets (USDT default)" },
        null,
        1,
      ),
    )
    return
  }

  if (old && old.username === "rewards") {
    old.username = "rewards_old"
    await old.save({ validateBeforeSave: false }) // closed doc; don't trip unrelated validators
  }

  // 2. Fresh account. Role enum includes "rewards" on the 0.9.31 image.
  const fresh = new Account({
    username: "rewards",
    role: "rewards",
    level: 1,
    statusHistory: [
      { status: "active", comment: "referral-rewards funding account (bootstrap)", updatedAt: new Date() },
    ],
  })
  await fresh.save()
  const accountId = String(fresh._id) as AccountId

  // 3. Real wallets (IBEX-provisioned) — USD + USDT, default USDT.
  const usd = await addWalletIfNonexistent({
    accountId,
    type: WalletType.Checking,
    currency: WalletCurrency.Usd,
  })
  if (usd instanceof Error) throw usd
  const usdt = await addWalletIfNonexistent({
    accountId,
    type: WalletType.Checking,
    currency: WalletCurrency.Usdt,
  })
  if (usdt instanceof Error) throw usdt

  fresh.defaultWalletId = usdt.id
  await fresh.save()

  // 4. Verify via the same repos the payout path uses.
  const check = await AccountsRepository().findByRole("rewards")
  const wallets = await WalletsRepository().listByAccountId(accountId)

  console.log(
    JSON.stringify(
      {
        renamedOld: oldPlan,
        newAccountId: accountId,
        role: fresh.role,
        defaultWalletId: fresh.defaultWalletId,
        findByRoleResolves: !(check instanceof Error) && String((check as { id: string }).id) === accountId,
        wallets:
          wallets instanceof Error
            ? String(wallets)
            : wallets.map((w) => ({ id: w.id, currency: w.currency })),
        fundThisIbexAccount: usdt.id,
      },
      null,
      1,
    ),
  )
}

setupMongoConnection()
  .then(async (m) => {
    await run()
    await m?.connection.close()
    process.exit(0)
  })
  .catch((e) => {
    console.error(String(e))
    process.exit(1)
  })
