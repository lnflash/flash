import { PaymentSplitsConfig } from "@config"

import { SplitReceiveAccountError } from "@domain/payment-splits/errors"
import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"

import Ibex from "@services/ibex/client"
import { WalletsRepository } from "@services/mongoose"
import { PaymentSplitRulesRepository } from "@services/mongoose/payment-split-rules"
import {
  SplitReceiveAccountsRepository,
  type SplitReceiveAccountRecord,
} from "@services/mongoose/split-receive-accounts"

/**
 * ENG-717: the shadow receive account. A wallet with at least one enabled
 * split rule mints its EXTERNAL receive invoices on a Flash-owned IBEX
 * account (the shadow) instead of the merchant's own, so the merchant's
 * wallet never holds the gross. On settle, the webhook fans the shadow's
 * balance out — each rule's share, then the merchant's net — and the shadow
 * returns to zero.
 *
 * The shadow is permanent per wallet (decision 4). Its IBEX balance is
 * customer funds in transit (see the ops runbook line in the PR).
 */

// The wallet's currency as an IBEX currency id, for createAccount /
// createLnurlPay. Same mapping the wallet-creation path uses
// (src/services/mongoose/wallets.ts getIbexCurrencyId); kept local so this
// module reads as one unit.
const ibexCurrencyIdFor = (currency: WalletCurrency): IbexCurrencyId | Error => {
  switch (currency) {
    case WalletCurrency.Usd:
      return USDAmount.currencyId
    case WalletCurrency.Usdt:
      return USDTAmount.currencyId
    default:
      return new Error(`Unsupported split currency: ${currency}`)
  }
}

/**
 * Creates the shadow account + LNURL for `walletId` if it does not exist yet.
 * Fails the caller on any IBEX or persistence error: walletSplitsSet runs
 * this BEFORE saving rules, so a wallet is never left with enabled rules and
 * no shadow (routing would then fall back to the real account and split
 * nothing, silently).
 *
 * Idempotent: a second call for a wallet that already has a shadow returns
 * the existing record without touching IBEX.
 */
export const ensureReceiveAccount = async ({
  walletId,
  currency,
}: {
  walletId: WalletId
  currency: WalletCurrency
}): Promise<SplitReceiveAccountRecord | Error> => {
  const repo = SplitReceiveAccountsRepository()

  const existing = await repo.findByWalletId(walletId)
  if (existing instanceof Error) return existing
  if (existing) return existing

  const currencyId = ibexCurrencyIdFor(currency)
  if (currencyId instanceof Error) return new SplitReceiveAccountError(currencyId.message)

  // Named after the wallet so IBEX's account list stays readable; the real
  // key is walletId, unique in the collection here.
  const account = await Ibex.createAccount(`flash-splits-${walletId}`, currencyId)
  if (account instanceof Error) return new SplitReceiveAccountError(account.message)
  if (!account.id) {
    return new SplitReceiveAccountError("IBEX created no account id for the shadow")
  }

  const lnurl = await Ibex.createLnurlPay({ accountId: account.id, currencyId })
  if (lnurl instanceof Error) {
    // The IBEX account exists but is unusable for LNURL receives. walletSplitsSet
    // fails the mutation, so no rule is saved and nothing routes here yet — the
    // orphaned account is harmless, and the next save attempt re-ensures.
    return new SplitReceiveAccountError(lnurl.message)
  }

  const created = await repo.insert({
    walletId,
    ibexAccountId: account.id,
    currency,
    lnurlp: lnurl.lnurl,
  })
  if (created instanceof Error) return created
  if (!created.created) {
    // A concurrent save inserted first. Its record wins; ours is an orphaned
    // IBEX account no traffic is ever routed to.
    const winner = await repo.findByWalletId(walletId)
    if (winner instanceof Error) return winner
    if (winner) return winner
    return new SplitReceiveAccountError(
      "shadow receive account insert reported a duplicate but none was found",
    )
  }

  return {
    walletId,
    ibexAccountId: account.id,
    currency,
    lnurlp: lnurl.lnurl,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

/**
 * Whether the wallet currently routes its external receives through a shadow.
 * One read, no IBEX calls: the settle path and the LNURL resolver call this
 * per request, so it must stay cheap.
 */
export const hasEnabledSplits = async (walletId: WalletId): Promise<boolean | Error> => {
  if (!PaymentSplitsConfig.enabled) return false
  const rules = await PaymentSplitRulesRepository().listByWalletId(walletId, {
    enabledOnly: true,
  })
  if (rules instanceof Error) return rules
  return rules.length > 0
}

/**
 * Which IBEX account an EXTERNAL receive invoice for `walletId` is minted on:
 * the wallet's shadow when splits are on and the wallet has at least one
 * enabled rule, else the wallet's own account (the pre-v2 behavior).
 *
 * The fail-safe is deliberate: any error here returns `walletId`, so a new
 * mint site or a transient repo error lands the receive unsplit on the real
 * account rather than failing an invoice the user asked for.
 *
 * NOT for internal credits: send-intraledger, the cutover moves and split
 * payouts mint on the real account on purpose (they must not re-split).
 */
export const receiveAccountFor = async (walletId: WalletId): Promise<IbexAccountId> => {
  if (!PaymentSplitsConfig.enabled) return walletId

  const enabled = await hasEnabledSplits(walletId)
  if (enabled !== true) return walletId

  const wallet = await WalletsRepository().findById(walletId)
  if (wallet instanceof Error) return walletId

  const shadow = await ensureReceiveAccount({
    walletId,
    currency: wallet.currency,
  })
  if (shadow instanceof Error) {
    // A wallet with rules but no shadow yet (rules created before v2, or a
    // previous ensure failed). Minting on the real account is the fail-safe;
    // the next walletSplitsSet retries the ensure.
    return walletId
  }
  return shadow.ibexAccountId as IbexAccountId
}

/**
 * The wallet a shadow IBEX account backs, when `ibexAccountId` is a shadow.
 * Used by the on-receive webhook: a receive on a shadow settles through the
 * split pipeline (§2.3), a receive on a real account is an ordinary receive.
 */
export const resolveShadow = async (
  ibexAccountId: string,
): Promise<SplitReceiveAccountRecord | null | Error> =>
  SplitReceiveAccountsRepository().findByIbexAccountId(ibexAccountId)

export type { SplitReceiveAccountRecord }
