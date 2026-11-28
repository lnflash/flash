import { hubPublicKey } from "@services/ibex/hub-public-key"
import {
  DEFAULT_MAX_AMOUNT_MINOR,
  ProviderRejectedError,
  UsdtCheckoutError,
  usdtCheckoutService,
} from "@app/pos-usdt-checkout/checkout"
import { DEFAULT_CASH_WALLET_CLIENT_CAPABILITIES } from "@app/cash-wallet-cutover/client-capability"
import { resolveCashWalletPresentationForAccount } from "@app/cash-wallet-cutover/presentation-for-account"
import { effectiveAccountLevel } from "@domain/accounts"
import { AccountStatus } from "@domain/accounts/primitives"
import { RateLimitConfig } from "@domain/rate-limit"
import { WalletCurrency } from "@domain/shared"
import { checkedToWalletId, WalletType } from "@domain/wallets"
import Ibex from "@services/ibex/client"
import { IbexError } from "@services/ibex/errors"
import { baseLogger } from "@services/logger"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import { consumeLimiter } from "@services/rate-limit"

import { posUsdtStore } from "./store"

const logger = baseLogger.child({ module: "pos-usdt-checkout" })

/**
 * Off unless POS_USDT_CHECKOUT_ENABLED is "true". Then either qualifies:
 *
 *   POS_USDT_MIN_LEVEL        "1", "2" or "3": every ACTIVE account at or above
 *                             that level, through its USDT cash wallet.
 *   POS_USDT_RECEIVE_WALLETS  comma-separated USDT wallet ids that qualify
 *                             whatever their level (still ACTIVE only, still
 *                             the account's cash wallet).
 *
 * POS_USDT_MAX_AMOUNT_MINOR caps one sale, in US cents (default 1000000).
 *
 * The register presents the merchant's public cash wallet. Provider receipts
 * always settle to the same merchant's existing USDT checking wallet.
 */
export const posUsdtCheckoutEnabled = () =>
  process.env.POS_USDT_CHECKOUT_ENABLED === "true"

const minimumLevel = (): AccountLevel | undefined => {
  const raw = (process.env.POS_USDT_MIN_LEVEL || "").trim()
  return /^[123]$/.test(raw) ? (Number(raw) as AccountLevel) : undefined
}

const maximumAmountMinor = (): number | undefined => {
  const raw = (process.env.POS_USDT_MAX_AMOUNT_MINOR || "").trim()
  if (!raw) return DEFAULT_MAX_AMOUNT_MINOR
  if (!/^[1-9]\d{0,9}$/.test(raw)) return undefined
  const n = Number(raw)
  return Number.isSafeInteger(n) && n <= 2_000_000_000 ? n : undefined
}

// Definitive refusals: IBEX answered and created nothing.
const definitelyRefused = (error: IbexError) =>
  error.httpCode !== undefined &&
  error.httpCode >= 400 &&
  error.httpCode < 500 &&
  error.httpCode !== 408 &&
  error.httpCode !== 409 &&
  error.httpCode !== 429

async function cashWallet(recipient: string) {
  const id = checkedToWalletId(recipient)
  if (id instanceof Error) return undefined
  const wallet = await WalletsRepository().findById(id)
  if (
    wallet instanceof Error ||
    (wallet.currency !== WalletCurrency.Usd && wallet.currency !== WalletCurrency.Usdt) ||
    wallet.type !== WalletType.Checking
  )
    return undefined
  const account = await AccountsRepository().findById(wallet.accountId)
  if (account instanceof Error || account.status !== AccountStatus.Active)
    return undefined
  // Require an existing settlement wallet before resolving the public default.
  // Passing that snapshot prevents this receive-only checkout from invoking
  // the cutover helper's missing-wallet repair.
  const owned = await WalletsRepository().listByAccountId(account.id)
  if (owned instanceof Error) return undefined
  const candidates = owned.filter(
    (w) =>
      w.accountId === account.id &&
      w.currency === WalletCurrency.Usdt &&
      w.type === WalletType.Checking,
  )
  if (candidates.length !== 1) return undefined
  const presentation = await resolveCashWalletPresentationForAccount({
    account,
    client: DEFAULT_CASH_WALLET_CLIENT_CAPABILITIES,
    walletsRepo: { listByAccountId: async () => owned },
  })
  if (presentation instanceof Error || presentation.defaultWalletId !== wallet.id)
    return undefined
  return { wallet, account, settlement: candidates[0] }
}

export function flashUsdtCheckout() {
  if (!posUsdtCheckoutEnabled()) return null
  const minLevel = minimumLevel()
  const maxAmountMinor = maximumAmountMinor()
  const wallets = new Set(
    (process.env.POS_USDT_RECEIVE_WALLETS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
  if ((!wallets.size && minLevel === undefined) || maxAmountMinor === undefined)
    return null

  return usdtCheckoutService({
    store: posUsdtStore,
    maxAmountMinor,
    async enabled(recipient) {
      // Only issue addresses when the webhook can verify incoming deposits.
      if (!hubPublicKey) return false
      const found = await cashWallet(recipient)
      if (!found) return false
      const eligible =
        wallets.has(found.settlement.id) ||
        (minLevel !== undefined && effectiveAccountLevel(found.account.level) >= minLevel)
      return eligible ? found.settlement.id : false
    },
    async limitNew(recipient, ip) {
      const found = await cashWallet(recipient)
      if (!found)
        throw new UsdtCheckoutError("USDT checkout is unavailable for this wallet.")
      const accountId = found.wallet.accountId
      // A merchant's wallet id is public: the per-IP bucket comes first so one
      // caller cannot spend the merchant's whole allocation.
      for (const [rateLimitConfig, keyToConsume] of [
        [RateLimitConfig.posUsdtAddressCreatePerIp, `${ip}:${accountId}`],
        [RateLimitConfig.posUsdtAddressCreate, accountId],
      ] as const) {
        const result = await consumeLimiter({
          rateLimitConfig,
          keyToConsume: keyToConsume as AccountId,
        })
        if (result instanceof Error)
          throw new UsdtCheckoutError(
            "Address allocation is temporarily unavailable. Retry this sale later.",
          )
      }
    },
    async newReceiveInfo(walletId, name) {
      const option = await Ibex.getEthereumUsdtOption()
      // Nothing was created yet.
      if (option instanceof Error) throw new ProviderRejectedError(option.message)
      // A copy: never the shared option object, which the Bridge flow renames.
      const result = await Ibex.createCryptoReceiveInfo(walletId as IbexAccountId, {
        ...option,
        name,
      })
      if (result instanceof IbexError) {
        if (definitelyRefused(result)) throw new ProviderRejectedError(result.message)
        throw result
      }
      if (result instanceof Error) throw result
      return result
    },
    async reservedAddresses(walletId) {
      const found = await cashWallet(walletId)
      if (!found)
        throw new UsdtCheckoutError("USDT checkout is unavailable for this wallet.")
      // The Bridge deposit address is never handed to a sale.
      const bridge = found.account.bridgeEthereumAddress
      return bridge ? [bridge] : []
    },
    async readPosted(transactionId) {
      const tx = await Ibex.getTransactionDetails(transactionId as IbexTransactionId)
      if (tx instanceof Error) return null
      const txid = await Ibex.getTransactionNetworkId(transactionId)
      if (txid instanceof Error) return null
      const t = tx as unknown as Record<string, unknown>
      return {
        accountId: t.accountId,
        amount: t.amount,
        transactionTypeId: t.transactionTypeId,
        status: t.status,
        currencyId: t.currencyId,
        txid,
      }
    },
    report(event, detail) {
      logger.warn({ event, ...detail }, "POS USDT checkout: refused or unverified")
    },
  })
}
