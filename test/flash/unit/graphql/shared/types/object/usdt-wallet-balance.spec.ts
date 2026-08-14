const mockGetBalanceForWallet = jest.fn()

jest.mock("@app", () => ({
  Wallets: {
    getBalanceForWallet: (...args: Parameters<typeof mockGetBalanceForWallet>) =>
      mockGetBalanceForWallet(...args),
  },
}))

// The @app/cash-wallet-cutover barrel drags in workers/runtime services that
// boot app infra on import (redis retries hang the unit harness). The balance
// resolver only needs the pure conversion; transaction resolvers (not queried
// here) use the presentation helpers.
jest.mock("@app/cash-wallet-cutover", () => ({
  ...jest.requireActual("@app/cash-wallet-cutover/presentation"),
  ...jest.requireActual("@app/cash-wallet-cutover/amount-conversion"),
}))

import { graphql, GraphQLObjectType, GraphQLSchema } from "graphql"

import UsdtWallet from "@graphql/shared/types/object/usdt-wallet"

import { USDTAmount, WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"

const walletSource = {
  id: "33333333-3333-4333-8333-333333333333" as WalletId,
  accountId: "cash-account-id" as AccountId,
  currency: WalletCurrency.Usdt,
  type: WalletType.Checking,
  onChainAddressIdentifiers: [],
  onChainAddresses: () => [],
  lnurlp: "lnurlp-usdt" as Lnurl,
} as unknown as Wallet

// A real query through a real schema wrapping the real UsdtWallet type: the
// resolver feeds `balance.asSmallestUnits()` into usdtMicrosToUsdCents and the
// FractionalCentAmount scalar serializes the result onto the wire. This seam
// has regressed twice (#230 for USD, this PR's bug for USDT) and the pure-unit
// suite cannot see it.
const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: "Query",
    fields: {
      wallet: {
        type: UsdtWallet,
        resolve: () => walletSource,
      },
    },
  }),
})

const queryBalance = async () =>
  graphql({
    schema,
    source: "{ wallet { balance } }",
    contextValue: {},
  })

const usdtBalance = (micros: string): USDTAmount => {
  const amount = USDTAmount.smallestUnits(micros)
  if (amount instanceof Error) throw amount
  return amount
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("UsdtWallet balance via GraphQL query", () => {
  it("serves fractional cents on the wire (device repro: 1,099,346 micros)", async () => {
    mockGetBalanceForWallet.mockResolvedValue(usdtBalance("1099346"))

    const result = await queryBalance()

    expect(result.errors).toBeUndefined()
    expect(result.data?.wallet).toEqual({ balance: 109.9346 })
    expect(mockGetBalanceForWallet).toHaveBeenCalledWith({
      walletId: walletSource.id,
      currency: WalletCurrency.Usdt,
    })
  })

  it("serves whole-cent balances as the integer", async () => {
    mockGetBalanceForWallet.mockResolvedValue(usdtBalance("1100000"))

    const result = await queryBalance()

    expect(result.errors).toBeUndefined()
    expect(result.data?.wallet).toEqual({ balance: 110 })
  })

  it("serves a negative balance instead of erroring (signed FractionalCentAmount)", async () => {
    // IBEX can report a small negative balance (fee reconciliation / ledger
    // anomaly); the field must serve it, not break the wallet screen.
    mockGetBalanceForWallet.mockResolvedValue(usdtBalance("-123"))

    const result = await queryBalance()

    expect(result.errors).toBeUndefined()
    expect(result.data?.wallet).toEqual({ balance: -0.0123 })
  })

  it("maps a malformed balance through mapError instead of leaking a raw error", async () => {
    const corrupt = Object.create(USDTAmount.prototype) as USDTAmount
    corrupt.asSmallestUnits = () => "not-a-number"
    mockGetBalanceForWallet.mockResolvedValue(corrupt)

    const result = await queryBalance()

    expect(result.data?.wallet).toEqual({ balance: null })
    expect(result.errors).toHaveLength(1)
    const original = result.errors?.[0]?.originalError as
      | (Error & { extensions?: { code?: string } })
      | undefined
    expect(original?.extensions?.code).toBe("INVALID_INPUT")
  })
})
