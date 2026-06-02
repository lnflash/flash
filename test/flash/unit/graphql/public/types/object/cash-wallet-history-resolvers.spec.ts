const mockGetTransactionsForAccountByWalletIds = jest.fn()
const mockGetTransactionsForWallets = jest.fn()
const mockGetTransactionsForWalletsByAddresses = jest.fn()
const mockResolveCashWalletPresentationForAccount = jest.fn()

jest.mock("@app", () => ({
  Accounts: {
    getTransactionsForAccountByWalletIds: (
      ...args: Parameters<typeof mockGetTransactionsForAccountByWalletIds>
    ) => mockGetTransactionsForAccountByWalletIds(...args),
  },
  Prices: {},
  Wallets: {
    getTransactionsForWallets: (
      ...args: Parameters<typeof mockGetTransactionsForWallets>
    ) => mockGetTransactionsForWallets(...args),
    getTransactionsForWalletsByAddresses: (
      ...args: Parameters<typeof mockGetTransactionsForWalletsByAddresses>
    ) => mockGetTransactionsForWalletsByAddresses(...args),
  },
}))

jest.mock("@app/cash-wallet-cutover", () => {
  const presentation = jest.requireActual("@app/cash-wallet-cutover/presentation")

  return {
    cashWalletHistoryWalletIdsForPresentation:
      presentation.cashWalletHistoryWalletIdsForPresentation,
    cashWalletHistoryWalletsForPresentation:
      presentation.cashWalletHistoryWalletsForPresentation,
    resolveCashWalletPresentationForAccount: (
      ...args: Parameters<typeof mockResolveCashWalletPresentationForAccount>
    ) => mockResolveCashWalletPresentationForAccount(...args),
  }
})

import ConsumerAccount from "@graphql/public/types/object/consumer-account"
import BusinessAccount from "@graphql/public/types/object/business-account"
import UsdWallet from "@graphql/shared/types/object/usd-wallet"
import UsdtWallet from "@graphql/shared/types/object/usdt-wallet"

import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"

const accountId = "cash-account-id" as AccountId
const account = {
  id: accountId,
  uuid: "cash-account-uuid" as AccountUuid,
  displayCurrency: "USD" as DisplayCurrency,
} as Account

const client = {
  cashWalletPresentation: "usdt",
  hasUsdtCashWalletSupport: true,
} as const

const context = {
  domainAccount: account,
  cashWalletClientCapabilities: client,
} as GraphQLPublicContextAuth

const wallet = ({
  id,
  currency,
  type = WalletType.Checking,
}: {
  id: string
  currency: WalletCurrency
  type?: WalletType
}): Wallet =>
  ({
    id: id as WalletId,
    accountId,
    currency,
    type,
    onChainAddressIdentifiers: [],
    onChainAddresses: () => [],
    lnurlp: `lnurlp-${id}` as Lnurl,
  }) as Wallet

const btcWallet = wallet({
  id: "11111111-1111-4111-8111-111111111111",
  currency: WalletCurrency.Btc,
})
const legacyUsdWallet = wallet({
  id: "22222222-2222-4222-8222-222222222222",
  currency: WalletCurrency.Usd,
})
const usdtWallet = wallet({
  id: "33333333-3333-4333-8333-333333333333",
  currency: WalletCurrency.Usdt,
})

const presentation = {
  wallets: [btcWallet, usdtWallet],
  defaultWalletId: usdtWallet.id,
  legacyUsdWallet,
  activeSettlementWallet: usdtWallet,
}

const emptyConnectionResult = {
  result: { slice: [], total: 0 },
  partialResult: true,
}

beforeEach(() => {
  jest.clearAllMocks()
  mockResolveCashWalletPresentationForAccount.mockResolvedValue(presentation)
  mockGetTransactionsForAccountByWalletIds.mockResolvedValue(emptyConnectionResult)
  mockGetTransactionsForWallets.mockResolvedValue(emptyConnectionResult)
  mockGetTransactionsForWalletsByAddresses.mockResolvedValue(emptyConnectionResult)
})

const resolveField = async ({
  objectType,
  field,
  source,
  args,
}: {
  objectType: typeof ConsumerAccount
  field: string
  source: unknown
  args: Record<string, unknown>
}) => {
  const resolver = objectType.getFields()[field].resolve
  if (!resolver) throw new Error(`Missing resolver for ${field}`)

  return resolver(source, args, context, {} as never, {} as never)
}

describe("account Cash Wallet transaction resolvers", () => {
  it("expands ConsumerAccount legacy USD filters to active USDT history then legacy USD archive", async () => {
    await resolveField({
      objectType: ConsumerAccount,
      field: "transactions",
      source: account,
      args: { first: 20, walletIds: [legacyUsdWallet.id] },
    })

    expect(mockGetTransactionsForAccountByWalletIds).toHaveBeenCalledWith({
      account,
      walletIds: [usdtWallet.id, legacyUsdWallet.id],
      paginationArgs: { first: 20, walletIds: [legacyUsdWallet.id] },
    })
  })

  it("expands BusinessAccount default Cash Wallet history to active USDT then legacy USD archive", async () => {
    await resolveField({
      objectType: BusinessAccount,
      field: "transactions",
      source: account,
      args: { first: 20 },
    })

    expect(mockGetTransactionsForAccountByWalletIds).toHaveBeenCalledWith({
      account,
      walletIds: [btcWallet.id, usdtWallet.id, legacyUsdWallet.id],
      paginationArgs: { first: 20 },
    })
  })
})

describe("wallet object Cash Wallet transaction resolvers", () => {
  it("expands legacy USD wallet object transactions to active USDT history then legacy USD archive", async () => {
    await resolveField({
      objectType: UsdWallet,
      field: "transactions",
      source: legacyUsdWallet,
      args: { first: 20 },
    })

    expect(mockGetTransactionsForWallets).toHaveBeenCalledWith({
      wallets: [usdtWallet, legacyUsdWallet],
      paginationArgs: { first: 20 },
    })
  })

  it("expands USDT wallet object transactions to active USDT history then legacy USD archive", async () => {
    await resolveField({
      objectType: UsdtWallet,
      field: "transactions",
      source: usdtWallet,
      args: { first: 20 },
    })

    expect(mockGetTransactionsForWallets).toHaveBeenCalledWith({
      wallets: [usdtWallet, legacyUsdWallet],
      paginationArgs: { first: 20 },
    })
  })

  it("expands wallet object transactionsByAddress across active USDT and legacy USD backing wallets", async () => {
    const address = "bc1-cash-wallet-address" as OnChainAddress

    await resolveField({
      objectType: UsdWallet,
      field: "transactionsByAddress",
      source: legacyUsdWallet,
      args: { first: 20, address },
    })

    expect(mockGetTransactionsForWalletsByAddresses).toHaveBeenCalledWith({
      wallets: [usdtWallet, legacyUsdWallet],
      addresses: [address],
      paginationArgs: { first: 20, address },
    })
  })

  it("keeps wrong-account wallet object history scoped to the source wallet only", async () => {
    const otherAccountUsdWallet = wallet({
      id: "44444444-4444-4444-8444-444444444444",
      currency: WalletCurrency.Usd,
    })

    await resolveField({
      objectType: UsdWallet,
      field: "transactions",
      source: {
        ...otherAccountUsdWallet,
        accountId: "other-account-id" as AccountId,
      },
      args: { first: 20 },
    })

    expect(mockGetTransactionsForWallets).toHaveBeenCalledWith({
      wallets: [
        {
          ...otherAccountUsdWallet,
          accountId: "other-account-id" as AccountId,
        },
      ],
      paginationArgs: { first: 20 },
    })
  })
})
