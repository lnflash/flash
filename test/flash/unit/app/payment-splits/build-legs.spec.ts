const mockListRules = jest.fn()
const mockIsInternal = jest.fn()

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

import { PaymentSplitsConfig } from "@config"
import { buildLegs } from "@app/payment-splits/build-legs"
import { WalletCurrency } from "@domain/shared"

import { createFakeExecutionsStore } from "./fake-executions-store"

// Read lazily by the repository mock above, so defining it after the imports
// is safe: the mock factory only captures the reference.
const mockStore = createFakeExecutionsStore()

const WALLET = "source-wallet"
const SHADOW = "shadow-ibex-account"
const HASH = "a".repeat(64)
const RULE_CREATED = new Date("2026-10-01T00:00:00Z")
const NOW = new Date("2026-10-19T12:00:00Z")

const rules = (defs: { dest: string; percent: number }[]) =>
  defs.map((d, i) => ({
    id: `rule-${i + 1}`,
    walletId: WALLET,
    destinationWalletId: d.dest,
    percent: d.percent,
    enabled: true,
    createdAt: RULE_CREATED,
  }))

const build = (overrides: Record<string, unknown> = {}) =>
  buildLegs({
    walletId: WALLET,
    sourceIbexAccountId: SHADOW,
    triggerKey: HASH,
    paymentHash: HASH,
    grossAmount: 10,
    currency: WalletCurrency.Usdt,
    now: NOW,
    ...overrides,
  })

beforeEach(() => {
  jest.clearAllMocks()
  mockStore.rows.clear()
  Object.assign(PaymentSplitsConfig, {
    enabled: true,
    minShareCents: 1,
    claimGraceMs: 120_000,
  })
  mockListRules.mockResolvedValue(rules([{ dest: "dest-1", percent: 10 }]))
  mockIsInternal.mockResolvedValue(false)
})

describe("buildLegs", () => {
  it("builds one share leg per enabled rule plus one net leg", async () => {
    mockListRules.mockResolvedValue(
      rules([
        { dest: "dest-1", percent: 10 },
        { dest: "dest-2", percent: 25 },
      ]),
    )

    const result = await build({ grossAmount: 10 }) // 10 USDT

    expect(result).toEqual({ recorded: 3, duplicates: 0 })
    const legs = [...mockStore.rows.values()]
    const share1 = legs.find((l) => l.destinationWalletId === "dest-1")
    const share2 = legs.find((l) => l.destinationWalletId === "dest-2")
    const net = legs.find((l) => l.legKind === "net")
    // 10 USDT = 10_000_000 micros; 10% = 1_000_000 micros = 100 cents;
    // 25% = 2_500_000 micros = 250 cents.
    expect(share1).toMatchObject({ legKind: "share", shareCents: 100 })
    expect(share2).toMatchObject({ legKind: "share", shareCents: 250 })
    // net = gross − Σ shares = 1000 − 350 = 650 cents; dust to the merchant.
    expect(net).toMatchObject({
      legKind: "net",
      destinationWalletId: WALLET,
      shareCents: 650,
      grossMinor: "10000000",
      sourceIbexAccountId: SHADOW,
    })
    // Every leg pays FROM the shadow and carries the full gross.
    expect(legs.every((l) => l.sourceIbexAccountId === SHADOW)).toBe(true)
  })

  it("is exact to the cent on USD (gross 10.00, 33% share)", async () => {
    mockListRules.mockResolvedValue(rules([{ dest: "dest-1", percent: 33 }]))

    await build({ grossAmount: 10, currency: WalletCurrency.Usd })

    const share = [...mockStore.rows.values()].find((l) => l.legKind === "share")
    const net = [...mockStore.rows.values()].find((l) => l.legKind === "net")
    // 1000 cents * 33% = 330 cents exactly; net = 670.
    expect(share).toMatchObject({ shareCents: 330 })
    expect(net).toMatchObject({ shareCents: 670 })
  })

  it("floors USDT shares per rule and leaves the dust to the merchant", async () => {
    mockListRules.mockResolvedValue(
      rules([
        { dest: "dest-1", percent: 33 },
        { dest: "dest-2", percent: 33 },
      ]),
    )

    await build({ grossAmount: 0.01 }) // 10_000 micros

    const legs = [...mockStore.rows.values()]
    // 10_000 micros * 33% = 3_300 micros = 0.33 cents → floors to 0 cents,
    // which is below minShareCents (1) → both fold into the net.
    expect(legs.filter((l) => l.legKind === "share")).toHaveLength(0)
    const net = legs.find((l) => l.legKind === "net")
    expect(net).toMatchObject({ shareCents: 1 })
  })

  it("folds a sub-minShareCents share into the net leg", async () => {
    Object.assign(PaymentSplitsConfig, { minShareCents: 50 })
    mockListRules.mockResolvedValue(
      rules([
        { dest: "tiny", percent: 1 },
        { dest: "big", percent: 50 },
      ]),
    )

    await build({ grossAmount: 10 })

    const legs = [...mockStore.rows.values()]
    // tiny: 1% of 1000 cents = 10 cents < 50 → folded, no row.
    expect(legs.find((l) => l.destinationWalletId === "tiny")).toBeUndefined()
    expect(legs.find((l) => l.destinationWalletId === "big")).toMatchObject({
      shareCents: 500,
    })
    // net = 1000 − 500 = 500 (the tiny share's 10 cents stay with the merchant).
    expect(legs.find((l) => l.legKind === "net")).toMatchObject({ shareCents: 500 })
  })

  it("replays idempotently: building the same receive N times yields one leg set", async () => {
    mockListRules.mockResolvedValue(
      rules([
        { dest: "dest-1", percent: 10 },
        { dest: "dest-2", percent: 25 },
      ]),
    )

    for (let i = 0; i < 3; i++) await build()
    expect(mockStore.rows.size).toBe(3)
    const replay = await build()
    if (replay instanceof Error) throw replay
    expect(replay).toMatchObject({ recorded: 0 })
  })

  it("snapshots the rules at settle time: edits after settle do not affect built legs", async () => {
    await build({ grossAmount: 10 })

    // The merchant re-saves with different percentages; legs already built
    // keep their shareCents (they are rows, not live rule references).
    mockListRules.mockResolvedValue(rules([{ dest: "dest-1", percent: 99 }]))

    // A replay of the same trigger builds nothing new.
    const replay = await build({ grossAmount: 10 })
    if (replay instanceof Error) throw replay
    expect(replay.recorded).toBe(0)
    expect([...mockStore.rows.values()].find((l) => l.legKind === "share")).toMatchObject(
      {
        shareCents: 100,
      },
    )
  })

  it("with no enabled rules builds only the net leg (the money IS in the shadow)", async () => {
    mockListRules.mockResolvedValue([])

    const result = await build()

    expect(result).toEqual({ recorded: 1, duplicates: 0 })
    expect([...mockStore.rows.values()]).toEqual([
      expect.objectContaining({
        legKind: "net",
        destinationWalletId: WALLET,
        shareCents: 1000,
      }),
    ])
  })

  it("holds every leg back for claimGraceMs (LNURL marker lands first)", async () => {
    await build()

    const legs = [...mockStore.rows.values()]
    expect(legs.every((l) => l.status === "pending")).toBe(true)
    expect(legs[0].nextAttemptAt).toEqual(new Date(NOW.getTime() + 120_000))
  })

  it("builds nothing while the feature flag is off", async () => {
    PaymentSplitsConfig.enabled = false

    expect(await build()).toEqual({ recorded: 0, duplicates: 0 })
    expect(mockStore.rows.size).toBe(0)
  })

  it("skips a receive whose hash marks it an internal transfer", async () => {
    mockIsInternal.mockResolvedValue(true)

    expect(await build()).toEqual({ recorded: 0, duplicates: 0 })
    expect(mockStore.rows.size).toBe(0)
  })

  it("errors when the shares would exceed the gross (defensive; save-time validation makes it unreachable)", async () => {
    // Rules cannot sum over 100, so force it through a stale snapshot: two
    // rules listed with overlapping percentages beyond 100 via a direct repo
    // stub returning 60 + 60.
    mockListRules.mockResolvedValue(
      rules([
        { dest: "dest-1", percent: 60 },
        { dest: "dest-2", percent: 60 },
      ]),
    )

    const result = await build({ grossAmount: 10 })
    expect(result).toBeInstanceOf(Error)
    expect(mockStore.rows.size).toBe(0)
  })
})
