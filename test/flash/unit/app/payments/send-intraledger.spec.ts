const mockAddInvoice = jest.fn()
const mockPayInvoice = jest.fn()
const mockFindWalletById = jest.fn()
const mockFindAccountById = jest.fn()

// In-memory backing stores for the ENG-530 idempotency helper (see the
// "intraledger idempotency" describe block below). Keyed on the scoped cache/lock
// key so different (wallet, key) pairs stay independent.
const mockCacheStore = new Map<string, unknown>()
const mockHeldLocks = new Set<string>()

jest.mock("@config", () => ({
  getCallbackServiceConfig: jest.fn(() => ({})),
  getValuesToSkipProbe: jest.fn(() => []),
}))

jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: jest.fn().mockResolvedValue(undefined),
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

jest.mock("@services/lock", () => {
  const { ResourceAttemptsLockServiceError } = jest.requireActual("@domain/lock")
  return {
    LockService: jest.fn(() => ({
      // Models a redlock `.using` lock: if the scoped key is already held, fail
      // (busy) without running the callback; otherwise run under the lock and
      // release afterwards.
      lockPaymentIdempotencyKey: async (
        key: string,
        asyncFn: (signal: unknown) => Promise<unknown>,
      ) => {
        if (mockHeldLocks.has(key)) return new ResourceAttemptsLockServiceError()
        mockHeldLocks.add(key)
        try {
          return await asyncFn({ aborted: false })
        } finally {
          mockHeldLocks.delete(key)
        }
      },
    })),
  }
})

jest.mock("@services/cache", () => ({
  RedisCacheService: jest.fn(() => ({
    get: async ({ key }: { key: string }) =>
      mockCacheStore.has(key) ? mockCacheStore.get(key) : new Error("cache miss"),
    set: async ({ key, value }: { key: string; value: unknown }) => {
      mockCacheStore.set(key, value)
      return value
    },
  })),
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
import {
  IdempotencyKeyReuseError,
  MismatchedCurrencyForWalletError,
} from "@domain/errors"
import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"
import { notifyOpsEvent } from "@services/alerts/ops-events"

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

describe("intraledger send ops events", () => {
  beforeEach(() => {
    jest.clearAllMocks()

    mockFindAccountById.mockImplementation(async (accountId: AccountId) =>
      activeAccount(accountId as string),
    )
    mockAddInvoice.mockResolvedValue({ invoice: { bolt11: "lnbc1recipient" } })
    mockPayInvoice.mockResolvedValue({ status: 2 })
    mockFindWalletById.mockImplementation(async (walletId: WalletId) =>
      wallet({
        id: walletId,
        accountId:
          walletId === senderUsdWalletId ? "sender-account" : "recipient-account",
        currency: WalletCurrency.Usd,
      }),
    )
  })

  const sendArgs = {
    senderWalletId: senderUsdWalletId,
    recipientWalletId: recipientUsdWalletId,
    amount: 100,
    memo: "ops event test",
  }

  it("notifies a succeeded transfer event with display amount on success", async () => {
    const result = await intraledgerPaymentSendWalletIdForUsdWallet(sendArgs)

    expect(result).toEqual({ value: "success" })
    expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "transfer",
        phase: "succeeded",
        status: "success",
        // display units, not cents: 100 cents -> $1.00
        amount: { value: "1.00", currency: "USD" },
        meta: {
          senderWalletId: senderUsdWalletId,
          recipientWalletId: recipientUsdWalletId,
        },
      }),
    )
  })

  it("notifies a failed transfer event with the error name on error return", async () => {
    mockFindWalletById.mockImplementation(async (walletId: WalletId) =>
      wallet({
        id: walletId,
        accountId:
          walletId === senderUsdWalletId ? "sender-account" : "recipient-account",
        currency:
          walletId === senderUsdWalletId ? WalletCurrency.Usd : WalletCurrency.Usdt,
      }),
    )

    const result = await intraledgerPaymentSendWalletIdForUsdWallet(sendArgs)

    expect(result).toBeInstanceOf(MismatchedCurrencyForWalletError)
    expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "transfer",
        phase: "failed",
        status: "failed",
        error: "MismatchedCurrencyForWalletError",
        meta: expect.objectContaining({ reason: "error-return" }),
      }),
    )
  })

  it("notifies a failed transfer event when the sender wallet fails wrapper validation", async () => {
    mockFindWalletById.mockImplementation(async (walletId: WalletId) =>
      wallet({
        id: walletId,
        accountId:
          walletId === senderUsdWalletId ? "sender-account" : "recipient-account",
        currency: WalletCurrency.Btc,
      }),
    )

    const result = await intraledgerPaymentSendWalletIdForUsdWallet(sendArgs)

    expect(result).toBeInstanceOf(MismatchedCurrencyForWalletError)
    expect(mockAddInvoice).not.toHaveBeenCalled()
    expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "transfer",
        phase: "failed",
        status: "failed",
        error: "MismatchedCurrencyForWalletError",
        amount: { value: "1.00", currency: "USD" },
        meta: expect.objectContaining({ reason: "error-return" }),
      }),
    )
  })

  it("distinguishes an Ibex status failure from an error return", async () => {
    mockPayInvoice.mockResolvedValue({ status: 3 })

    await intraledgerPaymentSendWalletIdForUsdWallet(sendArgs)

    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "transfer",
        phase: "failed",
        status: "failed",
        meta: expect.objectContaining({ reason: "status-failure" }),
      }),
    )
    expect((notifyOpsEvent as jest.Mock).mock.calls[0][0].error).toBeUndefined()
  })

  it("notifies a pending transfer event when Ibex reports pending", async () => {
    mockPayInvoice.mockResolvedValue({ status: 1 })

    await intraledgerPaymentSendWalletIdForUsdWallet(sendArgs)

    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ flow: "transfer", phase: "pending", status: "pending" }),
    )
  })
})

describe("intraledger idempotency (ENG-530)", () => {
  // The incident: a $140 USDT intraledger send fired twice ~1.5s apart and both
  // executed. These tests prove that a client-supplied idempotency key makes the
  // underlying IBEX send run at most once.
  const sendArgs = {
    senderWalletId: senderUsdWalletId,
    recipientWalletId: recipientUsdWalletId,
    amount: 14000,
    memo: "idempotency test",
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockCacheStore.clear()
    mockHeldLocks.clear()

    mockFindAccountById.mockImplementation(async (accountId: AccountId) =>
      activeAccount(accountId as string),
    )
    mockAddInvoice.mockResolvedValue({ invoice: { bolt11: "lnbc1recipient" } })
    mockPayInvoice.mockResolvedValue({ status: 2 })
    mockFindWalletById.mockImplementation(async (walletId: WalletId) => {
      const isUsdt = walletId === senderUsdtWalletId || walletId === recipientUsdtWalletId
      const isSender = walletId === senderUsdWalletId || walletId === senderUsdtWalletId
      return wallet({
        id: walletId,
        accountId: isSender ? "sender-account" : "recipient-account",
        currency: isUsdt ? WalletCurrency.Usdt : WalletCurrency.Usd,
      })
    })
  })

  it("executes once and replays the cached result on a repeated send with the same key", async () => {
    const first = await intraledgerPaymentSendWalletIdForUsdWallet({
      ...sendArgs,
      idempotencyKey: "dup-key",
    })
    const second = await intraledgerPaymentSendWalletIdForUsdWallet({
      ...sendArgs,
      idempotencyKey: "dup-key",
    })

    expect(first).toEqual({ value: "success" })
    expect(second).toEqual({ value: "success" })
    // The underlying IBEX send ran exactly once (no second invoice, no double-pay).
    expect(mockAddInvoice).toHaveBeenCalledTimes(1)
    expect(mockPayInvoice).toHaveBeenCalledTimes(1)
    // And the ops event fired exactly once — no duplicate on the cached replay.
    expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
  })

  it("executes once for a concurrent double-fire with the same key", async () => {
    // Hold the IBEX pay open so the first send is still in flight (lock held) when
    // the second fire arrives — the exact race from the incident.
    let releasePay: (v: unknown) => void = () => undefined
    const payReached = new Promise<void>((resolve) => {
      mockPayInvoice.mockImplementation(() => {
        resolve()
        return new Promise((res) => {
          releasePay = res
        })
      })
    })

    const firstPromise = intraledgerPaymentSendWalletIdForUsdWallet({
      ...sendArgs,
      idempotencyKey: "race-key",
    })
    await payReached // first send is mid-flight, holding the lock

    const second = await intraledgerPaymentSendWalletIdForUsdWallet({
      ...sendArgs,
      idempotencyKey: "race-key",
    })

    // The concurrent request was rejected as busy — it did NOT execute a second send.
    expect(second).toBeInstanceOf(Error)
    expect(mockAddInvoice).toHaveBeenCalledTimes(1)

    releasePay({ status: 2 })
    const first = await firstPromise

    expect(first).toEqual({ value: "success" })
    expect(mockAddInvoice).toHaveBeenCalledTimes(1)
    expect(mockPayInvoice).toHaveBeenCalledTimes(1)
  })

  it("executes separately for different keys", async () => {
    await intraledgerPaymentSendWalletIdForUsdWallet({
      ...sendArgs,
      idempotencyKey: "key-a",
    })
    await intraledgerPaymentSendWalletIdForUsdWallet({
      ...sendArgs,
      idempotencyKey: "key-b",
    })

    expect(mockAddInvoice).toHaveBeenCalledTimes(2)
    expect(notifyOpsEvent).toHaveBeenCalledTimes(2)
  })

  it("executes every time when no key is supplied (backwards-compatible)", async () => {
    await intraledgerPaymentSendWalletIdForUsdWallet(sendArgs)
    await intraledgerPaymentSendWalletIdForUsdWallet(sendArgs)

    // No key => no dedupe, no cache writes.
    expect(mockAddInvoice).toHaveBeenCalledTimes(2)
    expect(mockCacheStore.size).toBe(0)
  })

  it("does not collide across sender wallets that reuse the same key", async () => {
    await intraledgerPaymentSendWalletIdForUsdWallet({
      senderWalletId: senderUsdWalletId,
      recipientWalletId: recipientUsdWalletId,
      amount: 100,
      memo: null,
      idempotencyKey: "shared",
    })
    await intraledgerPaymentSendWalletIdForUsdWallet({
      senderWalletId: senderUsdtWalletId,
      recipientWalletId: recipientUsdtWalletId,
      amount: 100,
      memo: null,
      idempotencyKey: "shared",
    })

    // Different sender wallet => different scope => both execute.
    expect(mockAddInvoice).toHaveBeenCalledTimes(2)
  })

  it("rejects the same key reused for a different payment instead of replaying", async () => {
    const first = await intraledgerPaymentSendWalletIdForUsdWallet({
      ...sendArgs,
      idempotencyKey: "conflict-key",
    })
    // Same key, but a different amount — a genuinely different payment.
    const second = await intraledgerPaymentSendWalletIdForUsdWallet({
      ...sendArgs,
      amount: 999,
      idempotencyKey: "conflict-key",
    })

    expect(first).toEqual({ value: "success" })
    // Not a silent replay of the first payment's success — a clear conflict.
    expect(second).toBeInstanceOf(IdempotencyKeyReuseError)
    // And the conflicting request did NOT send.
    expect(mockAddInvoice).toHaveBeenCalledTimes(1)
    expect(mockPayInvoice).toHaveBeenCalledTimes(1)
  })
})
