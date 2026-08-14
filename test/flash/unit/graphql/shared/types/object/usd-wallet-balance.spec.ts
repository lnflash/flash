const mockGetBalanceForWallet = jest.fn()
const mockResolveCashWalletPresentationForAccount = jest.fn()

jest.mock("@app", () => ({
  Wallets: {
    getBalanceForWallet: (...args: Parameters<typeof mockGetBalanceForWallet>) =>
      mockGetBalanceForWallet(...args),
  },
}))

// The @app/cash-wallet-cutover barrel drags in workers/runtime services that
// boot app infra on import (redis retries hang the unit harness). Keep the
// pure conversion real — it is part of the seam under test — and mock the
// presentation resolution so the cutover redirect can be steered per test.
jest.mock("@app/cash-wallet-cutover", () => ({
  ...jest.requireActual("@app/cash-wallet-cutover/presentation"),
  ...jest.requireActual("@app/cash-wallet-cutover/amount-conversion"),
  resolveCashWalletPresentationForAccount: (
    ...args: Parameters<typeof mockResolveCashWalletPresentationForAccount>
  ) => mockResolveCashWalletPresentationForAccount(...args),
}))

import { graphql, GraphQLObjectType, GraphQLSchema } from "graphql"

import UsdWallet from "@graphql/shared/types/object/usd-wallet"

import { USDTAmount, WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"

const legacyUsdWallet = {
  id: "11111111-1111-4111-8111-111111111111" as WalletId,
  accountId: "cash-account-id" as AccountId,
  currency: WalletCurrency.Usd,
  type: WalletType.Checking,
  onChainAddressIdentifiers: [],
  onChainAddresses: () => [],
  lnurlp: "lnurlp-usd" as Lnurl,
} as unknown as Wallet

const usdtSettlementWallet = {
  id: "33333333-3333-4333-8333-333333333333" as WalletId,
  accountId: "cash-account-id" as AccountId,
  currency: WalletCurrency.Usdt,
  type: WalletType.Checking,
  onChainAddressIdentifiers: [],
  onChainAddresses: () => [],
  lnurlp: "lnurlp-usdt" as Lnurl,
} as unknown as Wallet

const domainAccount = { id: legacyUsdWallet.accountId } as Account

const clientCapabilities = {
  cashWalletPresentation: "usdt",
  hasUsdtCashWalletSupport: true,
}

// A real query through a real schema wrapping the real UsdWallet type. This is
// the path a post-cutover client hits when it queries the LEGACY wallet id:
// resolveCashWalletPresentationForAccount redirects the legacy wallet to the
// USDT settlement wallet, and the balance must still serve fractional cents.
// This exact field has regressed twice (#230, this PR's bug) and the
// UsdtWallet spec cannot see a UsdWallet-only regression.
const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: "Query",
    fields: {
      wallet: {
        type: UsdWallet,
        resolve: () => legacyUsdWallet,
      },
    },
  }),
})

const queryBalance = async () =>
  graphql({
    schema,
    source: "{ wallet { balance } }",
    contextValue: {
      domainAccount,
      cashWalletClientCapabilities: clientCapabilities,
    },
  })

const usdtBalance = (micros: string): USDTAmount => {
  const amount = USDTAmount.smallestUnits(micros)
  if (amount instanceof Error) throw amount
  return amount
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("UsdWallet balance via GraphQL query (post-cutover redirect)", () => {
  it("serves fractional cents from the redirected USDT settlement wallet (device repro: 1,099,346 micros)", async () => {
    mockResolveCashWalletPresentationForAccount.mockResolvedValue({
      wallets: [usdtSettlementWallet],
      defaultWalletId: usdtSettlementWallet.id,
      legacyUsdWallet,
      activeSettlementWallet: usdtSettlementWallet,
    })
    mockGetBalanceForWallet.mockResolvedValue(usdtBalance("1099346"))

    const result = await queryBalance()

    expect(result.errors).toBeUndefined()
    expect(result.data?.wallet).toEqual({ balance: 109.9346 })
    expect(mockResolveCashWalletPresentationForAccount).toHaveBeenCalledWith({
      account: domainAccount,
      client: clientCapabilities,
    })
    // The redirect must swap the balance lookup onto the settlement wallet.
    expect(mockGetBalanceForWallet).toHaveBeenCalledWith({
      walletId: usdtSettlementWallet.id,
      currency: WalletCurrency.Usdt,
    })
  })
})
