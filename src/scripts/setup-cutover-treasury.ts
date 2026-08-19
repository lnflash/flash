#!/usr/bin/env node
// One-off (ENG-482 / ENG-461 rehearsal): give the funder account a USDT wallet
// and make it the default, so getTreasuryWalletId() resolves to a USDT-capable
// treasury for cutover fee reimbursements. Prints the wallet + IBEX account id
// to fund. Idempotent. Dry-run unless --apply is passed.
import { addWalletIfNonexistent, updateDefaultWalletId } from "@app/accounts"
import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import { setupMongoConnection } from "@services/mongodb"
import { baseLogger } from "@services/logger"

const apply = process.argv.includes("--apply")

// Funder account id (role:"funder") on TEST — matches funderWalletResolver's
// Account.findOne({ role: "funder" }).
const FUNDER_ACCOUNT_ID = (process.env.FUNDER_ACCOUNT_ID ||
  "66b030b64278550357f1413d") as AccountId

const run = async () => {
  const account = await AccountsRepository().findById(FUNDER_ACCOUNT_ID)
  if (account instanceof Error) throw account

  const before = await WalletsRepository().listByAccountId(account.id)
  if (before instanceof Error) throw before

  const summary: Record<string, unknown> = {
    apply,
    funderAccountId: account.id,
    currentDefaultWalletId: account.defaultWalletId,
    walletsBefore: before.map((w) => ({ id: w.id, currency: w.currency })),
  }

  if (!apply) {
    console.log(JSON.stringify({ ...summary, note: "dry-run; pass --apply to make changes" }, null, 1))
    return
  }

  const usdt = await addWalletIfNonexistent({
    accountId: account.id,
    type: WalletType.Checking,
    currency: WalletCurrency.Usdt,
  })
  if (usdt instanceof Error) throw usdt

  const updated = await updateDefaultWalletId({
    accountId: account.id,
    walletId: usdt.id,
  })
  if (updated instanceof Error) throw updated

  console.log(
    JSON.stringify(
      {
        ...summary,
        createdOrFoundUsdtWalletId: usdt.id,
        newDefaultWalletId: usdt.id,
        fundThisIbexAccount: usdt.id,
      },
      null,
      1,
    ),
  )
}

setupMongoConnection()
  .then(async (mongoose) => {
    await run()
    await mongoose?.connection.close()
    process.exit(0)
  })
  .catch((error) => {
    baseLogger.error({ error }, "setup-cutover-treasury failed")
    console.error(String(error))
    process.exit(1)
  })
