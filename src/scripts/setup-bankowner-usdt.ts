#!/usr/bin/env node
// One-off (TEST, cashout prerequisite): create the bankowner's USDT wallet.
// Cashout routing (cashout-routing.ts) hard-errors when the bankowner account
// has no USDT wallet. Unlike the cutover treasury, the DEFAULT wallet is left
// untouched — routing resolves the USDT wallet by currency. Idempotent;
// dry-run unless --apply.
import { addWalletIfNonexistent } from "@app/accounts"
import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import { setupMongoConnection } from "@services/mongodb"

const apply = process.argv.includes("--apply")

// USD or USDT (default USDT — original cashout prerequisite)
const CURRENCY = (process.env.WALLET_CURRENCY || "USDT").toUpperCase()

// role:"bankowner" account on TEST (statusHistory import artifact fixed 2026-07-05)
const BANKOWNER_ACCOUNT_ID = (process.env.BANKOWNER_ACCOUNT_ID ||
  "66b030b64278550357f1413f") as AccountId

const run = async () => {
  const account = await AccountsRepository().findById(BANKOWNER_ACCOUNT_ID)
  if (account instanceof Error) throw account

  const before = await WalletsRepository().listByAccountId(account.id)
  if (before instanceof Error) throw before

  const summary = {
    apply,
    bankownerAccountId: account.id,
    defaultWalletId: account.defaultWalletId,
    walletsBefore: before.map((w) => ({ id: w.id, currency: w.currency })),
  }

  if (!apply) {
    console.log(JSON.stringify({ ...summary, note: "dry-run; pass --apply" }, null, 1))
    return
  }

  const currency = CURRENCY === "USD" ? WalletCurrency.Usd : WalletCurrency.Usdt
  const usdt = await addWalletIfNonexistent({
    accountId: account.id,
    type: WalletType.Checking,
    currency,
  })
  if (usdt instanceof Error) throw usdt

  console.log(
    JSON.stringify(
      { ...summary, createdOrFoundWalletId: usdt.id, currency: CURRENCY, fundThisIbexAccount: usdt.id },
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
