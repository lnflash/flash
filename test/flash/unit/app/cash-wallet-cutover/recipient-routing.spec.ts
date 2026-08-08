const mockGetConfig = jest.fn()

jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({ findById: jest.fn() }),
  WalletsRepository: () => ({ findById: jest.fn(), listByAccountId: jest.fn() }),
  CashWalletCutoverRepository: () => ({
    getConfig: (...args: Parameters<typeof mockGetConfig>) => mockGetConfig(...args),
    findMigrationByAccountId: jest.fn(),
  }),
}))

import { resolveCashWalletRecipientMutationWalletId } from "@app/cash-wallet-cutover/recipient-routing"
import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"

const recipientAccountId = "recipient-account-id" as AccountId
const recipientWalletId = "11111111-1111-4111-8111-111111111111" as WalletId
const routedWalletId = "22222222-2222-4222-8222-222222222222" as WalletId

const recipientWallet = {
  id: recipientWalletId,
  accountId: recipientAccountId,
  currency: WalletCurrency.Usd,
  type: WalletType.Checking,
  onChainAddressIdentifiers: [],
  onChainAddresses: () => [],
  lnurlp: "lnurlp-recipient" as Lnurl,
} as Wallet

const recipientAccount = {
  id: recipientAccountId,
  uuid: "recipient-account-uuid" as AccountUuid,
} as Account

const client = {
  cashWalletPresentation: "usdt",
  hasUsdtCashWalletSupport: true,
} as const

describe("resolveCashWalletRecipientMutationWalletId", () => {
  it("routes recipient legacy USD wallet ids through the recipient account presentation", async () => {
    const walletsRepo = {
      findById: jest.fn().mockResolvedValue(recipientWallet),
      listByAccountId: jest.fn(),
    }
    const accountsRepo = {
      findById: jest.fn().mockResolvedValue(recipientAccount),
    }
    const resolveMutationWalletIdForAccount = jest.fn().mockResolvedValue(routedWalletId)

    const result = await resolveCashWalletRecipientMutationWalletId({
      recipientWalletId,
      client,
      walletsRepo,
      accountsRepo,
      resolveMutationWalletIdForAccount,
    })

    expect(result).toBe(routedWalletId)
    expect(walletsRepo.findById).toHaveBeenCalledWith(recipientWalletId)
    expect(accountsRepo.findById).toHaveBeenCalledWith(recipientAccountId)
    expect(resolveMutationWalletIdForAccount).toHaveBeenCalledWith({
      account: recipientAccount,
      walletId: recipientWalletId,
      client,
      walletsRepo,
    })
  })
})

// Composition test: the real recipient resolver through the real
// presentation/routing logic, with only the repos stubbed. This is the
// production incident scenario — a legacy-capability client submitting a
// recipient's legacy USD wallet id after the cutover completed.
describe("resolveCashWalletRecipientMutationWalletId (real routing)", () => {
  const usdtWalletId = "55555555-5555-4555-8555-555555555555" as WalletId
  const usdtWallet = {
    id: usdtWalletId,
    accountId: recipientAccountId,
    currency: WalletCurrency.Usdt,
    type: WalletType.Checking,
    onChainAddressIdentifiers: [],
    onChainAddresses: () => [],
    lnurlp: "lnurlp-recipient-usdt" as Lnurl,
  } as Wallet

  const legacyClient = {
    cashWalletPresentation: "legacy_compat",
    hasUsdtCashWalletSupport: false,
  } as const

  const accountsRepo = {
    findById: jest.fn(),
  }
  const walletsRepo = {
    findById: jest.fn(),
    listByAccountId: jest.fn(),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetConfig.mockResolvedValue({
      state: "complete",
      cutoverVersion: 1,
      updatedAt: new Date(),
    })
    accountsRepo.findById.mockResolvedValue(recipientAccount)
    walletsRepo.listByAccountId.mockResolvedValue([recipientWallet, usdtWallet])
  })

  it("resolves a legacy USD recipient id to the USDT settlement wallet post-cutover", async () => {
    walletsRepo.findById.mockResolvedValue(recipientWallet)

    const result = await resolveCashWalletRecipientMutationWalletId({
      recipientWalletId,
      client: legacyClient,
      walletsRepo,
      accountsRepo,
    })

    expect(result).toBe(usdtWalletId)
  })

  it("passes a recipient id that is already the settlement wallet through unchanged", async () => {
    walletsRepo.findById.mockResolvedValue(usdtWallet)

    const result = await resolveCashWalletRecipientMutationWalletId({
      recipientWalletId: usdtWalletId,
      client: legacyClient,
      walletsRepo,
      accountsRepo,
    })

    expect(result).toBe(usdtWalletId)
  })
})
