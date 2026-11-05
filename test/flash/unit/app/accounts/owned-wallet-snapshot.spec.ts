const mockAccount = jest.fn(),
  mockWallets = jest.fn()
jest.mock("@app/accounts/owned-wallet-snapshot-adapters", () => ({
  ownedWalletSnapshotDependencies: () => ({ account: mockAccount, wallets: mockWallets }),
}))

import {
  getOwnedWalletSnapshot,
  OwnedWalletSnapshotError,
} from "@app/accounts/owned-wallet-snapshot"
import { resolveCashWalletPresentation } from "@app/cash-wallet-cutover/presentation"

const INTERNAL = "507f1f77bcf86cd799439011",
  PUBLIC = "01909e14-2f56-41f2-afed-21c6f714c805",
  USER = "2d63fe66-f51d-4d3a-a75b-45087857305b"
const account = () =>
  ({
    id: INTERNAL,
    uuid: PUBLIC,
    kratosUserId: USER,
    defaultWalletId: "usdt-owned",
  }) as Account
const wallets = () =>
  [
    { id: "usd-owned", accountId: INTERNAL, type: "checking", currency: "USD" },
    { id: "usdt-owned", accountId: INTERNAL, type: "checking", currency: "USDT" },
  ] as Wallet[]
const run = (
  source: Account = account(),
  context: Account | undefined = account(),
  userId: UserId | undefined = USER as UserId,
) => getOwnedWalletSnapshot({ source, account: context, userId })
beforeEach(() => {
  jest.resetAllMocks()
  mockAccount.mockImplementation(async () => account())
  mockWallets.mockResolvedValue(wallets())
})

it("returns real raw cash rows and explicit distinct ownership namespaces without a presentation alias", async () => {
  const result = await run()
  expect(result).toEqual({
    publicAccountId: PUBLIC,
    walletAccountId: INTERNAL,
    defaultWalletId: "usdt-owned",
    wallets: [
      { id: "usd-owned", accountId: INTERNAL, walletCurrency: "USD", isExternal: false },
      {
        id: "usdt-owned",
        accountId: INTERNAL,
        walletCurrency: "USDT",
        isExternal: false,
      },
    ],
  })
  expect(PUBLIC).not.toBe(INTERNAL)
  expect(mockAccount).toHaveBeenCalledTimes(2)
  expect(mockWallets).toHaveBeenCalledWith(INTERNAL)
  expect(JSON.stringify(result)).not.toMatch(/balance|lnurl|provider|secret|token/i)
})

it("proves existing public presentation hides one cash currency and cannot supply raw readiness", () => {
  for (const presentation of ["usdt", "legacy_usd_compat", "legacy_usd"] as const) {
    const result = resolveCashWalletPresentation({
      decision: { presentation },
      wallets: wallets(),
    })
    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(result.wallets).toHaveLength(1)
    expect(result.wallets[0].currency).toBe(presentation === "usdt" ? "USDT" : "USD")
  }
})

it("preserves actual external/BTC default rather than the cash presentation default", async () => {
  const original = { ...account(), defaultWalletId: "external-btc" }
  mockAccount.mockResolvedValue(original)
  mockWallets.mockResolvedValue([
    ...wallets(),
    { id: "external-btc", accountId: INTERNAL, currency: "BTC", type: "external" },
  ])
  const result = await run()
  expect(result).not.toBeInstanceOf(Error)
  expect(result).toMatchObject({
    defaultWalletId: "external-btc",
    wallets: expect.arrayContaining([
      {
        id: "external-btc",
        accountId: INTERNAL,
        walletCurrency: "BTC",
        isExternal: true,
      },
    ]),
  })
})

it.each([undefined, null])(
  "returns an explicit nullable missing stored default (%s), never inventing a cash choice",
  async (value) => {
    mockAccount.mockResolvedValue({ ...account(), defaultWalletId: value })
    expect(await run()).toMatchObject({ defaultWalletId: null })
  },
)

it("does not call repositories for anonymous or foreign source/context ownership", async () => {
  for (const input of [
    { source: account() },
    { source: account(), account: account() },
    {
      source: { ...account(), id: "507f1f77bcf86cd799439012" as AccountId },
      account: account(),
      userId: USER as UserId,
    },
    {
      source: {
        ...account(),
        uuid: "b74355d9-40d6-43b9-ab6d-c08c78bc66bf" as AccountUuid,
      },
      account: account(),
      userId: USER as UserId,
    },
    {
      source: account(),
      account: account(),
      userId: "d677f049-ad7b-4f42-a243-f34a26c86043" as UserId,
    },
  ]) {
    expect(await getOwnedWalletSnapshot(input)).toMatchObject({ kind: "unauthenticated" })
  }
  expect(mockAccount).not.toHaveBeenCalled()
  expect(mockWallets).not.toHaveBeenCalled()
})

it.each(["id", "uuid", "kratosUserId"])(
  "rejects changed fresh account %s before exposing any wallets",
  async (field) => {
    mockAccount.mockResolvedValue({ ...account(), [field]: "different-owner" })
    expect(await run()).toBeInstanceOf(OwnedWalletSnapshotError)
    expect(mockWallets).not.toHaveBeenCalled()
  },
)

it("rejects owner/default drift across the awaited wallet read", async () => {
  for (const changed of [
    { ...account(), kratosUserId: "different-owner" },
    { ...account(), defaultWalletId: "usd-owned" },
  ]) {
    mockAccount
      .mockReset()
      .mockResolvedValueOnce(account())
      .mockResolvedValueOnce(changed)
    expect(await run()).toBeInstanceOf(OwnedWalletSnapshotError)
  }
})

it.each(
  [
    null,
    [null],
    [{ ...wallets()[0], accountId: "507f1f77bcf86cd799439012" }],
    [wallets()[0], wallets()[0]],
    [{ ...wallets()[0], id: "" }],
    [{ ...wallets()[0], currency: "UNKNOWN" }],
    [{ ...wallets()[0], type: "UNKNOWN" }],
  ].map((rows) => ({ rows })),
)("fails closed on invalid/nullable/foreign/duplicate raw records", async ({ rows }) => {
  mockWallets.mockResolvedValue(rows)
  expect(await run()).toBeInstanceOf(OwnedWalletSnapshotError)
})

it("rejects a foreign default, an oversized result and repository failures without exposing server prose", async () => {
  mockAccount.mockResolvedValue({ ...account(), defaultWalletId: "foreign-default" })
  expect(await run()).toBeInstanceOf(OwnedWalletSnapshotError)
  mockAccount.mockResolvedValue(account())
  mockWallets.mockResolvedValue(
    Array.from({ length: 1001 }, (_, i) => ({ ...wallets()[0], id: "wallet-" + i })),
  )
  expect(await run()).toBeInstanceOf(OwnedWalletSnapshotError)
  mockWallets.mockRejectedValue(new Error("PRIVATE_DATABASE_DETAILS"))
  const result = await run()
  expect(result).toBeInstanceOf(OwnedWalletSnapshotError)
  expect((result as Error).message).not.toContain("PRIVATE_DATABASE_DETAILS")
})

it("describes incomplete cash state without creating wallets or claiming readiness", async () => {
  mockAccount.mockResolvedValue({ ...account(), defaultWalletId: undefined })
  mockWallets.mockResolvedValue([])
  expect(await run()).toEqual({
    publicAccountId: PUBLIC,
    walletAccountId: INTERNAL,
    defaultWalletId: null,
    wallets: [],
  })
})
