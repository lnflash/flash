const mockAddInvoice = jest.fn()
const mockPayInvoice = jest.fn()
const mockFindWalletById = jest.fn()
const mockFindAccountById = jest.fn()

jest.mock("@config", () => ({
  getCallbackServiceConfig: jest.fn(() => ({})),
  getValuesToSkipProbe: jest.fn(() => []),
}))

jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))

jest.mock("@app/prices", () => ({
  btcFromUsdMidPriceFn: jest.fn(),
  getCurrentPriceAsDisplayPriceRatio: jest.fn(),
  usdFromBtcMidPriceFn: jest.fn(),
}))

jest.mock("@app/wallets", () => {
  const { MismatchedCurrencyForWalletError } = jest.requireActual("@domain/errors")
  const { WalletCurrency } = jest.requireActual("@domain/shared")

  const validateIsBtcWallet = jest.fn(async () => true)
  const validateIsUsdWallet = jest.fn(async (walletId, args) => {
    const wallet = await mockFindWalletById(walletId)
    if (wallet instanceof Error) return wallet

    if (
      wallet.currency === WalletCurrency.Usd ||
      (args?.includeUsdt === true && wallet.currency === WalletCurrency.Usdt)
    ) {
      return true
    }

    return new MismatchedCurrencyForWalletError()
  })

  return { validateIsBtcWallet, validateIsUsdWallet }
})

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    addInvoice: (...args: unknown[]) => mockAddInvoice(...args),
    payInvoice: (...args: unknown[]) => mockPayInvoice(...args),
  },
}))

jest.mock("@services/mongoose", () => ({
  AccountsRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindAccountById(...args),
  })),
  WalletsRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindWalletById(...args),
  })),
  UsersRepository: jest.fn(),
}))

jest.mock("@services/dealer-price", () => ({
  DealerPriceService: jest.fn(() => ({})),
}))

jest.mock("@services/lock", () => ({
  LockService: jest.fn(() => ({})),
}))

jest.mock("@services/ledger", () => ({
  LedgerService: jest.fn(() => ({})),
}))

jest.mock("@services/ledger/facade", () => ({}))

jest.mock("@services/notifications", () => ({
  NotificationsService: jest.fn(() => ({})),
}))

jest.mock("@services/svix", () => ({
  CallbackService: jest.fn(() => ({})),
}))

jest.mock("@app/payments/helpers", () => ({
  addContactsAfterSend: jest.fn(),
  checkIntraledgerLimits: jest.fn(async () => true),
  checkTradeIntraAccountLimits: jest.fn(async () => true),
  getPriceRatioForLimits: jest.fn(async () => ({})),
}))

import { intraledgerPaymentSendWalletIdForUsdWallet } from "@app/payments/send-intraledger"
import { MismatchedCurrencyForWalletError } from "@domain/errors"
import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"

const senderUsdWalletId = "11111111-1111-4111-8111-111111111111" as WalletId
const senderUsdtWalletId = "22222222-2222-4222-8222-222222222222" as WalletId
const recipientUsdWalletId = "33333333-3333-4333-8333-333333333333" as WalletId
const recipientUsdtWalletId = "44444444-4444-4444-8444-444444444444" as WalletId

const activeAccount = (id: string) =>
  ({
    id,
    status: "active",
    level: 1,
  }) as unknown as Account

const wallet = ({
  id,
  accountId,
  currency,
}: {
  id: string
  accountId: string
  currency: string
}) =>
  ({
    id,
    accountId,
    currency,
  }) as unknown as Wallet

describe("intraledgerPaymentSendWalletIdForUsdWallet", () => {
  beforeEach(() => {
    jest.clearAllMocks()

    mockFindAccountById.mockImplementation(async (accountId: AccountId) =>
      activeAccount(accountId as string),
    )
    mockAddInvoice.mockResolvedValue({ invoice: { bolt11: "lnbc1recipient" } })
    mockPayInvoice.mockResolvedValue({ status: 2 })
  })

  it("keeps USD to USD using cent amount semantics", async () => {
    mockFindWalletById.mockImplementation(async (walletId: WalletId) => {
      if (walletId === senderUsdWalletId) {
        return wallet({
          id: senderUsdWalletId,
          accountId: "sender-account",
          currency: WalletCurrency.Usd,
        })
      }
      return wallet({
        id: recipientUsdWalletId,
        accountId: "recipient-account",
        currency: WalletCurrency.Usd,
      })
    })

    const result = await intraledgerPaymentSendWalletIdForUsdWallet({
      senderWalletId: senderUsdWalletId,
      recipientWalletId: recipientUsdWalletId,
      amount: 19446,
      memo: "USD intraledger",
    })

    expect(result).toEqual({ value: "success" })
    expect(mockAddInvoice).toHaveBeenCalledWith({
      accountId: recipientUsdWalletId,
      amount: expect.any(USDAmount),
      memo: "USD intraledger",
    })
    expect(mockAddInvoice.mock.calls[0][0].amount.asCents()).toBe("19446")
    expect(mockAddInvoice.mock.calls[0][0].amount.toIbex()).toBe(194.46)
    expect(mockPayInvoice).toHaveBeenCalledWith({
      accountId: senderUsdWalletId,
      invoice: "lnbc1recipient",
    })
  })

  it("sends USDT to USDT using USD-cent amount semantics", async () => {
    mockFindWalletById.mockImplementation(async (walletId: WalletId) => {
      if (walletId === senderUsdtWalletId) {
        return wallet({
          id: senderUsdtWalletId,
          accountId: "sender-account",
          currency: WalletCurrency.Usdt,
        })
      }
      return wallet({
        id: recipientUsdtWalletId,
        accountId: "recipient-account",
        currency: WalletCurrency.Usdt,
      })
    })

    const result = await intraledgerPaymentSendWalletIdForUsdWallet({
      senderWalletId: senderUsdtWalletId,
      recipientWalletId: recipientUsdtWalletId,
      amount: 19446,
      memo: "USDT intraledger",
    })

    expect(result).toEqual({ value: "success" })
    expect(mockAddInvoice).toHaveBeenCalledWith({
      accountId: recipientUsdtWalletId,
      amount: expect.any(USDTAmount),
      memo: "USDT intraledger",
    })
    expect(mockAddInvoice.mock.calls[0][0].amount.asSmallestUnits()).toBe("194460000")
    expect(mockAddInvoice.mock.calls[0][0].amount.toIbex()).toBe(194.46)
    expect(mockPayInvoice).toHaveBeenCalledWith({
      accountId: senderUsdtWalletId,
      invoice: "lnbc1recipient",
    })
  })

  it("rejects USD to USDT as a mixed-currency intraledger payment", async () => {
    mockFindWalletById.mockImplementation(async (walletId: WalletId) => {
      if (walletId === senderUsdWalletId) {
        return wallet({
          id: senderUsdWalletId,
          accountId: "sender-account",
          currency: WalletCurrency.Usd,
        })
      }
      return wallet({
        id: recipientUsdtWalletId,
        accountId: "recipient-account",
        currency: WalletCurrency.Usdt,
      })
    })

    const result = await intraledgerPaymentSendWalletIdForUsdWallet({
      senderWalletId: senderUsdWalletId,
      recipientWalletId: recipientUsdtWalletId,
      amount: 100,
      memo: "mixed currency",
    })

    expect(result).toBeInstanceOf(MismatchedCurrencyForWalletError)
    expect(mockAddInvoice).not.toHaveBeenCalled()
    expect(mockPayInvoice).not.toHaveBeenCalled()
  })

  it("rejects USDT to USD as a mixed-currency intraledger payment", async () => {
    mockFindWalletById.mockImplementation(async (walletId: WalletId) => {
      if (walletId === senderUsdtWalletId) {
        return wallet({
          id: senderUsdtWalletId,
          accountId: "sender-account",
          currency: WalletCurrency.Usdt,
        })
      }
      return wallet({
        id: recipientUsdWalletId,
        accountId: "recipient-account",
        currency: WalletCurrency.Usd,
      })
    })

    const result = await intraledgerPaymentSendWalletIdForUsdWallet({
      senderWalletId: senderUsdtWalletId,
      recipientWalletId: recipientUsdWalletId,
      amount: 100,
      memo: "mixed currency",
    })

    expect(result).toBeInstanceOf(MismatchedCurrencyForWalletError)
    expect(mockAddInvoice).not.toHaveBeenCalled()
    expect(mockPayInvoice).not.toHaveBeenCalled()
  })
})
