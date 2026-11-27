import { checkoutService, CheckoutError, Network } from "@app/pos-on-chain/checkout"
import { createOnChainAddress } from "@app/wallets/create-on-chain-address"
import { checkedToWalletId } from "@domain/wallets"
import { RateLimitConfig } from "@domain/rate-limit"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import { resolveCashWalletPresentationForAccount } from "@app/cash-wallet-cutover/presentation-for-account"
import { DEFAULT_CASH_WALLET_CLIENT_CAPABILITIES } from "@app/cash-wallet-cutover/client-capability"
import { consumeLimiter } from "@services/rate-limit"
import { esploraTotals } from "./indexer"
import { posOnChainStore } from "./store"

export function flashCheckout() {
  const network = process.env.POS_ONCHAIN_NETWORK as Network
  const origin = process.env.POS_ONCHAIN_ESPLORA
  const genesis = process.env.POS_ONCHAIN_GENESIS
  const wallets = new Set(
    (process.env.POS_ONCHAIN_RECEIVE_WALLETS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
  if (
    !wallets.size ||
    !origin ||
    !genesis ||
    !/^[0-9a-f]{64}$/.test(genesis) ||
    (network === "MAINNET" &&
      genesis !== "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f") ||
    !["MAINNET", "TESTNET", "SIGNET", "REGTEST"].includes(network)
  )
    return null
  const url = new URL(origin)
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    return null
  return checkoutService({
    network,
    store: posOnChainStore,
    enabled: (wallet) => wallets.has(wallet),
    totals: esploraTotals(origin, genesis),
    async limitNew(recipient) {
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
      const result = await consumeLimiter({
        rateLimitConfig: RateLimitConfig.onChainAddressCreate,
        keyToConsume: wallet.accountId,
      })
      if (result instanceof Error)
        throw new CheckoutError(
          "Address allocation is temporarily unavailable. Retry this sale later.",
        )
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
