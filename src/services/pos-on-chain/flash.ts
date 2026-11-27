import { checkoutService, CheckoutError, Network } from "@app/pos-on-chain/checkout"
import { createOnChainAddress } from "@app/wallets/create-on-chain-address"
import { effectiveAccountLevel } from "@domain/accounts"
import { AccountStatus } from "@domain/accounts/primitives"
import { checkedToWalletId } from "@domain/wallets"
import { RateLimitConfig } from "@domain/rate-limit"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import { resolveCashWalletPresentationForAccount } from "@app/cash-wallet-cutover/presentation-for-account"
import { DEFAULT_CASH_WALLET_CLIENT_CAPABILITIES } from "@app/cash-wallet-cutover/client-capability"
import { consumeLimiter } from "@services/rate-limit"
import { baseLogger } from "@services/logger"

import { esploraTotals, firstAvailable } from "./indexer"
import { posOnChainStore } from "./store"

/**
 * Who may receive through POS on-chain checkout. Either is enough:
 *
 *   POS_ONCHAIN_MIN_LEVEL       "1", "2" or "3". Every ACTIVE account at or
 *                               above that level qualifies through its cash
 *                               (USD or USDT) wallet. Nobody maintains a list.
 *                               Level 0 is not accepted here on purpose: a
 *                               device account costs nothing to create, and
 *                               each checkout issues a permanent custody
 *                               address.
 *   POS_ONCHAIN_RECEIVE_WALLETS comma-separated wallet ids that qualify
 *                               whatever their account's level (an inactive
 *                               account still does not qualify). For trying
 *                               the checkout on known wallets before the rule
 *                               is switched on, and for forcing one on.
 *
 * With neither set, or with the indexer settings missing or wrong, checkout is
 * off for everyone.
 *
 * POS_ONCHAIN_ESPLORA is one Esplora-compatible API base, or several separated
 * by commas. They are asked in the order given; a later one is used only while
 * an earlier one is failing (see `firstAvailable`). Every entry must be https
 * (http is accepted for localhost only), and one bad entry turns checkout off
 * rather than silently running on fewer indexers than the operator listed.
 */
const indexerOrigins = (): string[] | null => {
  const origins = (process.env.POS_ONCHAIN_ESPLORA || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (!origins.length || new Set(origins).size !== origins.length) return null
  for (const origin of origins) {
    let url: URL
    try {
      url = new URL(origin)
    } catch {
      return null
    }
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
    )
      return null
  }
  return origins
}

const minimumLevel = (): AccountLevel | undefined => {
  const raw = (process.env.POS_ONCHAIN_MIN_LEVEL || "").trim()
  return /^[123]$/.test(raw) ? (Number(raw) as AccountLevel) : undefined
}

export function flashCheckout() {
  const minLevel = minimumLevel()
  const network = process.env.POS_ONCHAIN_NETWORK as Network
  const origins = indexerOrigins()
  const genesis = process.env.POS_ONCHAIN_GENESIS
  const wallets = new Set(
    (process.env.POS_ONCHAIN_RECEIVE_WALLETS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
  if (
    (!wallets.size && minLevel === undefined) ||
    !origins ||
    !genesis ||
    !/^[0-9a-f]{64}$/.test(genesis) ||
    (network === "MAINNET" &&
      genesis !== "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f") ||
    !["MAINNET", "TESTNET", "SIGNET", "REGTEST"].includes(network)
  )
    return null
  return checkoutService({
    network,
    store: posOnChainStore,
    async enabled(recipient) {
      // A listed wallet bypasses the level, never the account status.
      const listed = wallets.has(recipient)
      if (!listed && minLevel === undefined) return false
      const id = checkedToWalletId(recipient)
      if (id instanceof Error) return false
      const wallet = await WalletsRepository().findById(id)
      if (wallet instanceof Error) return false
      // A listed BTC wallet still reaches limitNew's clearer custodial message.
      if (!listed && wallet.currency !== "USD" && wallet.currency !== "USDT") return false
      const account = await AccountsRepository().findById(wallet.accountId)
      if (account instanceof Error) return false
      if (account.status !== AccountStatus.Active) return false
      return (
        listed ||
        (minLevel !== undefined && effectiveAccountLevel(account.level) >= minLevel)
      )
    },
    totals: firstAvailable(
      origins.map((origin) => ({
        name: new URL(origin).host,
        read: esploraTotals(origin, genesis),
      })),
      (indexer, error) =>
        baseLogger.warn(
          { indexer, error: error instanceof Error ? error.message : String(error) },
          "POS on-chain checkout: indexer failed, trying the next one",
        ),
    ),
    async limitNew(recipient, ip) {
      const id = checkedToWalletId(recipient)
      if (id instanceof Error) throw new CheckoutError("Unknown receiving wallet.")
      const wallet = await WalletsRepository().findById(id)
      if (wallet instanceof Error) throw new CheckoutError("Unknown receiving wallet.")
      if (wallet.currency !== "USD" && wallet.currency !== "USDT")
        throw new CheckoutError(
          "This wallet does not support Flash custodial on-chain checkout.",
        )
      const account = await AccountsRepository().findById(wallet.accountId)
      if (account instanceof Error) throw new CheckoutError("Unknown receiving account.")
      // Match the merchant wallet returned by the POS username lookup, including a cash-wallet cutover.
      const presentation = await resolveCashWalletPresentationForAccount({
        account,
        client: DEFAULT_CASH_WALLET_CLIENT_CAPABILITIES,
      })
      if (presentation instanceof Error || presentation.defaultWalletId !== id)
        throw new CheckoutError(
          "Your receiving wallet changed. Reconnect your Flash account before starting a sale.",
        )
      // The POS's own buckets: a merchant's wallet id is public, so the merchant
      // bucket must not block, and one caller IP must not be able to spend it all.
      for (const [rateLimitConfig, keyToConsume] of [
        [RateLimitConfig.posOnChainAddressCreatePerIp, `${ip}:${wallet.accountId}`],
        [RateLimitConfig.posOnChainAddressCreate, wallet.accountId],
      ] as const) {
        const result = await consumeLimiter({
          rateLimitConfig,
          keyToConsume: keyToConsume as AccountId,
        })
        if (result instanceof Error)
          throw new CheckoutError(
            "Address allocation is temporarily unavailable. Retry this sale later.",
          )
      }
    },
    async newAddress(recipient) {
      const id = checkedToWalletId(recipient)
      if (id instanceof Error) throw new CheckoutError("Unknown receiving wallet.")
      // The same account validation and custody provider as Flash's authorized address-create mutation.
      const result = await createOnChainAddress({ walletId: id })
      if (result instanceof Error)
        throw new CheckoutError(
          "Flash could not issue a receiving address. Retry this sale later.",
        )
      return result
    },
  })
}
