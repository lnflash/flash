const mockFindWalletById = jest.fn()
const mockFindAccountById = jest.fn()
const mockFindUserById = jest.fn()
const mockLightningTxReceived = jest.fn()
const mockOnChainTxReceived = jest.fn()
const mockListRules = jest.fn()
const mockIsInternal = jest.fn()
const mockSend = jest.fn()

jest.mock("@services/ibex/webhook-server/middleware", () => ({
  authenticate: jest.fn((_req, _res, next) => next()),
  logRequest: jest.fn((_req, _res, next) => next()),
  validateIbexIp: jest.fn((_req, _res, next) => next()),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: jest.fn(),
}))

jest.mock("@services/mongoose", () => ({
  WalletsRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindWalletById(...args),
  })),
  AccountsRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindAccountById(...args),
  })),
  UsersRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindUserById(...args),
  })),
}))

jest.mock("@services/notifications", () => ({
  NotificationsService: jest.fn(() => ({
    lightningTxReceived: (...args: unknown[]) => mockLightningTxReceived(...args),
    onChainTxReceived: (...args: unknown[]) => mockOnChainTxReceived(...args),
  })),
}))

jest.mock("@app/prices", () => ({
  getCurrentPriceAsDisplayPriceRatio: jest.fn(async () => new Error("no price")),
}))

jest.mock("@app/users/remove-device-tokens", () => ({
  removeDeviceTokens: jest.fn(),
}))

jest.mock("@services/mongoose/zap-request", () => ({
  ZapRequestModel: { findOne: jest.fn(async () => null) },
}))

jest.mock("@services/nostr/zapPublisher", () => ({
  ZapPublisher: { publishFromWebhook: jest.fn() },
}))

jest.mock("@services/mongoose/payment-split-rules", () => ({
  PaymentSplitRulesRepository: jest.fn(() => ({
    listByWalletId: (...args: unknown[]) => mockListRules(...args),
  })),
}))

jest.mock("@services/mongoose/payment-split-executions", () => ({
  PaymentSplitExecutionsRepository: jest.fn(() => mockStore.repo),
}))

jest.mock("@services/mongoose/internal-transfer-invoices", () => ({
  isInternalTransferInvoice: (...args: unknown[]) => mockIsInternal(...args),
}))

// The webhook must never pay a split: payouts happen only in the cron executor.
jest.mock("@app/payments/send-intraledger", () => ({
  intraledgerPaymentSendWalletIdForUsdWallet: (...args: unknown[]) => mockSend(...args),
  intraledgerPaymentSendWalletIdForBtcWallet: (...args: unknown[]) => mockSend(...args),
}))

import { PaymentSplitsConfig } from "@config"
import { WalletCurrency } from "@domain/shared"
import { paths, router } from "@services/ibex/webhook-server/routes/on-receive"

import { createFakeExecutionsStore } from "test/flash/unit/app/payment-splits/fake-executions-store"

// Read lazily by the repository mock above, so defining it after the imports
// is safe: the mock factory only captures the reference.
const mockStore = createFakeExecutionsStore()

const WALLET = "receiver-wallet"
const HASH = "c".repeat(64)

type Handle = (req: unknown, res: unknown, next: () => void) => unknown

const handlesFor = (path: string): Handle[] => {
  const layer = (
    router.stack as Array<{
      route?: { path: string; stack: Array<{ handle: Handle }> }
    }>
  ).find((l) => l.route?.path === path)
  if (!layer?.route) throw new Error(`no route ${path}`)
  // Skip the rate limiter (first handle); the IBEX guards are mocked through.
  return layer.route.stack.slice(1).map((l) => l.handle)
}

const post = async (path: string, body: Record<string, unknown>) => {
  const res = {
    statusCode: 0,
    status(code: number) {
      this.statusCode = code
      return this
    },
    sendStatus(code: number) {
      this.statusCode = code
      return this
    },
    end() {
      return this
    },
  }
  const req = { body } as Record<string, unknown>
  for (const handle of handlesFor(path)) {
    let advanced = false
    await handle(req, res, () => {
      advanced = true
    })
    if (!advanced) break
  }
  return res
}

const lightningBody = (hash = HASH) => ({
  transaction: { accountId: WALLET, amount: 10, invoice: { hash } },
  receivedMsat: 1000,
})

const originalEnabled = PaymentSplitsConfig.enabled

beforeEach(() => {
  jest.clearAllMocks()
  mockStore.rows.clear()
  PaymentSplitsConfig.enabled = true
  mockFindWalletById.mockResolvedValue({ id: WALLET, currency: WalletCurrency.Usdt })
  mockFindAccountById.mockResolvedValue({
    id: "acct",
    kratosUserId: "user",
    displayCurrency: "USD",
  })
  mockFindUserById.mockResolvedValue({ id: "user", deviceTokens: [] })
  mockLightningTxReceived.mockResolvedValue(true)
  mockOnChainTxReceived.mockResolvedValue(true)
  mockListRules.mockResolvedValue([
    {
      id: "rule-1",
      walletId: WALLET,
      destinationWalletId: "dest",
      percent: 20,
      enabled: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  ])
  mockIsInternal.mockResolvedValue(false)
})

afterAll(() => {
  PaymentSplitsConfig.enabled = originalEnabled
})

describe("on-receive webhook payment splits (ENG-653)", () => {
  it.each([
    ["invoice", paths.invoice],
    ["lnurl", paths.lnurl],
  ])("the %s route records splits and never sends", async (_name, path) => {
    const res = await post(path, lightningBody())

    expect(res.statusCode).toBe(200)
    expect([...mockStore.rows.values()]).toEqual([
      expect.objectContaining({
        triggerKey: HASH,
        walletId: WALLET,
        destinationWalletId: "dest",
        shareCents: 200,
        status: "pending",
      }),
    ])
    expect(mockSend).not.toHaveBeenCalled()
    // The receive notification still runs after the split step.
    expect(mockLightningTxReceived).toHaveBeenCalledTimes(1)
  })

  it("a replayed webhook records nothing new", async () => {
    await post(paths.invoice, lightningBody())
    await post(paths.invoice, lightningBody())

    expect(mockStore.rows.size).toBe(1)
  })

  it("a replay after the split was re-saved records nothing new", async () => {
    await post(paths.invoice, lightningBody())
    // walletSplitsSet gave the same destination a fresh rule id.
    mockListRules.mockResolvedValue([
      {
        id: "rule-1-resaved",
        walletId: WALLET,
        destinationWalletId: "dest",
        percent: 20,
        enabled: true,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ])
    await post(paths.invoice, lightningBody())

    expect(mockStore.rows.size).toBe(1)
  })

  it("does not fire a rule created after the receive in the webhook body", async () => {
    mockListRules.mockResolvedValue([
      {
        id: "rule-new",
        walletId: WALLET,
        destinationWalletId: "dest",
        percent: 20,
        enabled: true,
        createdAt: new Date("2026-10-11T12:01:00Z"),
      },
    ])

    const res = await post(paths.invoice, {
      transaction: {
        accountId: WALLET,
        amount: 10,
        invoice: { hash: HASH },
        createdAt: "2026-10-11T12:00:00Z",
      },
      receivedMsat: 1000,
    })

    expect(res.statusCode).toBe(200)
    expect(mockStore.rows.size).toBe(0)
  })

  it("fires a rule created before the receive in the webhook body", async () => {
    const res = await post(paths.invoice, {
      transaction: {
        accountId: WALLET,
        amount: 10,
        invoice: { hash: HASH },
        settledAt: "2026-10-11T12:00:00Z",
      },
      receivedMsat: 1000,
    })

    expect(res.statusCode).toBe(200)
    expect(mockStore.rows.size).toBe(1)
  })

  it.each([
    ["onchain", paths.onchain],
    ["zap", paths.zap],
  ])("the %s route records nothing", async (_name, path) => {
    const res = await post(path, {
      transaction: { accountId: WALLET, amount: 10, invoice: { hash: HASH }, hash: "tx" },
    })

    expect(res.statusCode).toBe(200)
    expect(mockListRules).not.toHaveBeenCalled()
    expect(mockStore.rows.size).toBe(0)
  })

  it("records nothing for a Fygaro top-up or referral payout (marked internal hash)", async () => {
    mockIsInternal.mockImplementation(async (hash: string) => hash === HASH)

    const res = await post(paths.invoice, lightningBody())

    expect(res.statusCode).toBe(200)
    expect(mockIsInternal).toHaveBeenCalledWith(HASH)
    expect(mockStore.rows.size).toBe(0)
    expect(mockLightningTxReceived).toHaveBeenCalledTimes(1)
  })

  it("still returns 200 when recording fails", async () => {
    mockListRules.mockResolvedValue(new Error("mongo down"))

    const res = await post(paths.invoice, lightningBody())

    expect(res.statusCode).toBe(200)
    expect(mockLightningTxReceived).toHaveBeenCalledTimes(1)
  })

  it("still returns 200 when recording throws", async () => {
    mockListRules.mockRejectedValue(new Error("boom"))

    const res = await post(paths.invoice, lightningBody())

    expect(res.statusCode).toBe(200)
  })

  it("skips a body with no valid payment hash", async () => {
    await post(paths.invoice, lightningBody("not-a-hash"))

    expect(mockListRules).not.toHaveBeenCalled()
  })
})
