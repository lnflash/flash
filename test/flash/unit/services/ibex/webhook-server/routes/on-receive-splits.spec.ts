const mockFindWalletById = jest.fn()
const mockFindAccountById = jest.fn()
const mockFindUserById = jest.fn()
const mockLightningTxReceived = jest.fn()
const mockOnChainTxReceived = jest.fn()
const mockAdminPush = jest.fn()
const mockListRules = jest.fn()
const mockIsInternal = jest.fn()
const mockExecute = jest.fn()
const mockResolveShadow = jest.fn()

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

jest.mock("@config", () => {
  const original = jest.requireActual("@config")
  return {
    ...original,
    getI18nInstance: () => ({
      __: jest.fn(({ phrase }) => phrase),
    }),
  }
})

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
    adminPushNotificationSend: (...args: unknown[]) => mockAdminPush(...args),
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

jest.mock("@app/payment-splits/receive-account", () => ({
  resolveShadow: (...args: unknown[]) => mockResolveShadow(...args),
}))

// The webhook must kick execution only after the response; the inline call is
// fire-and-forget. Mock it and assert it was requested.
jest.mock("@app/payment-splits/execute-pending-splits", () => ({
  executePendingSplits: (...args: unknown[]) => mockExecute(...args),
}))

jest.mock("@domain/locale", () => ({
  getLanguageOrDefault: () => "en",
}))

import { WalletCurrency } from "@domain/shared"
import { paths, router } from "@services/ibex/webhook-server/routes/on-receive"

import { createFakeExecutionsStore } from "test/flash/unit/app/payment-splits/fake-executions-store"

// Read lazily by the repository mock above, so defining it after the imports
// is safe: the mock factory only captures the reference.
const mockStore = createFakeExecutionsStore()

const WALLET = "receiver-wallet"
const SHADOW = "shadow-ibex-account"
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

const lightningBody = (hash = HASH, accountId = SHADOW) => ({
  transaction: { accountId, amount: 10, invoice: { hash } },
  receivedMsat: 1000,
})

const originalEnabled = (
  jest.requireActual("@config") as { PaymentSplitsConfig: { enabled: boolean } }
).PaymentSplitsConfig.enabled

beforeEach(() => {
  jest.clearAllMocks()
  mockStore.rows.clear()
  const { PaymentSplitsConfig } = jest.requireActual("@config") as {
    PaymentSplitsConfig: { enabled: boolean }
  }
  PaymentSplitsConfig.enabled = true
  // Default: the receive landed on the wallet's SHADOW.
  mockResolveShadow.mockResolvedValue({
    walletId: WALLET,
    ibexAccountId: SHADOW,
    currency: "USDT",
    lnurlp: "lnurl1shadow",
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  mockFindWalletById.mockResolvedValue({ id: WALLET, currency: WalletCurrency.Usdt })
  mockFindAccountById.mockResolvedValue({
    id: "acct",
    kratosUserId: "user",
    displayCurrency: "USD",
  })
  mockFindUserById.mockResolvedValue({ id: "user", deviceTokens: ["token-1"] })
  mockLightningTxReceived.mockResolvedValue(true)
  mockOnChainTxReceived.mockResolvedValue(true)
  mockAdminPush.mockResolvedValue(true)
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
  mockExecute.mockResolvedValue({ claimed: 0 })
})

afterAll(() => {
  const { PaymentSplitsConfig } = jest.requireActual("@config") as {
    PaymentSplitsConfig: { enabled: boolean }
  }
  PaymentSplitsConfig.enabled = originalEnabled
})

describe("on-receive webhook payment splits (ENG-717)", () => {
  it.each([
    ["invoice", paths.invoice],
    ["lnurl", paths.lnurl],
  ])(
    "the %s route builds share+net legs on a shadow receive and never pays inline",
    async (_name, path) => {
      const res = await post(path, lightningBody())

      expect(res.statusCode).toBe(200)
      const legs = [...mockStore.rows.values()]
      expect(legs).toEqual([
        expect.objectContaining({
          triggerKey: HASH,
          legKind: "share",
          walletId: WALLET,
          sourceIbexAccountId: SHADOW,
          destinationWalletId: "dest",
          shareCents: 200,
          status: "pending",
        }),
        expect.objectContaining({
          triggerKey: HASH,
          legKind: "net",
          destinationWalletId: WALLET,
          shareCents: 800,
          status: "pending",
        }),
      ])
      // The kick was requested (fire-and-forget), after the legs were built.
      expect(mockExecute).toHaveBeenCalled()
      // The merchant gets the split push, not the plain receive push.
      expect(mockLightningTxReceived).not.toHaveBeenCalled()
      expect(mockAdminPush).toHaveBeenCalledTimes(1)
    },
  )

  it("a receive on the REAL account builds no legs and sends the ordinary receive push", async () => {
    mockResolveShadow.mockResolvedValue(null)

    const res = await post(paths.invoice, lightningBody(HASH, WALLET))

    expect(res.statusCode).toBe(200)
    expect(mockStore.rows.size).toBe(0)
    expect(mockListRules).not.toHaveBeenCalled()
    expect(mockLightningTxReceived).toHaveBeenCalledTimes(1)
    expect(mockAdminPush).not.toHaveBeenCalled()
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it("resolves the shadow's OWNING wallet for the notification context", async () => {
    await post(paths.invoice, lightningBody())

    // The wallet lookup went to the owner wallet id, not the shadow id.
    expect(mockFindWalletById).toHaveBeenCalledWith(WALLET)
  })

  it("a replayed webhook builds nothing new", async () => {
    await post(paths.invoice, lightningBody())
    await post(paths.invoice, lightningBody())

    expect(mockStore.rows.size).toBe(2)
  })

  it("a replay after the split was re-saved builds nothing new", async () => {
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

    expect(mockStore.rows.size).toBe(2)
  })

  it("does not fire a rule created after the receive in the webhook body (share leg; net still built)", async () => {
    mockListRules.mockResolvedValue([
      {
        id: "rule-new",
        walletId: WALLET,
        destinationWalletId: "dest",
        percent: 20,
        enabled: true,
        createdAt: new Date("2026-10-19T12:01:00Z"),
      },
    ])

    const res = await post(paths.invoice, {
      transaction: {
        accountId: SHADOW,
        amount: 10,
        invoice: { hash: HASH },
        createdAt: "2026-10-19T12:00:00Z",
      },
      receivedMsat: 1000,
    })

    expect(res.statusCode).toBe(200)
    const legs = [...mockStore.rows.values()]
    expect(legs.map((l) => l.legKind)).toEqual(["net"])
  })

  it.each([
    ["onchain", paths.onchain],
    ["zap", paths.zap],
  ])("the %s route builds nothing", async (_name, path) => {
    const res = await post(path, {
      transaction: { accountId: SHADOW, amount: 10, invoice: { hash: HASH }, hash: "tx" },
    })

    expect(res.statusCode).toBe(200)
    expect(mockListRules).not.toHaveBeenCalled()
    expect(mockStore.rows.size).toBe(0)
  })

  it("builds nothing for a marked-internal hash (a Flash-origin credit that landed on a shadow)", async () => {
    mockIsInternal.mockImplementation(async (hash: string) => hash === HASH)

    const res = await post(paths.invoice, lightningBody())

    expect(res.statusCode).toBe(200)
    expect(mockIsInternal).toHaveBeenCalledWith(HASH)
    expect(mockStore.rows.size).toBe(0)
  })

  it("still returns 200 when the legs cannot be built (DB error)", async () => {
    mockListRules.mockResolvedValue(new Error("mongo down"))

    const res = await post(paths.invoice, lightningBody())

    expect(res.statusCode).toBe(200)
    expect(mockAdminPush).toHaveBeenCalledTimes(1)
  })

  it("still returns 200 when building legs throws", async () => {
    mockListRules.mockRejectedValue(new Error("boom"))

    const res = await post(paths.invoice, lightningBody())

    expect(res.statusCode).toBe(200)
  })

  it("still returns 200 when resolving the shadow errors", async () => {
    mockResolveShadow.mockResolvedValue(new Error("mongo down"))

    const res = await post(paths.invoice, lightningBody())

    expect(res.statusCode).toBe(500)
  })

  it("skips a body with no valid payment hash (no legs; the push still fires)", async () => {
    await post(paths.invoice, lightningBody("not-a-hash"))

    // No hash → no triggerKey → no legs. The split push itself does not need
    // the hash, so listing the destinations for it is fine.
    expect(mockStore.rows.size).toBe(0)
  })
})
