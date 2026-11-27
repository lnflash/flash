import { randomUUID } from "crypto"

import { networks, payments } from "bitcoinjs-lib"

import { RateLimitConfig } from "@domain/rate-limit"
import { OnChainAddressCreateRateLimiterExceededError } from "@domain/rate-limit/errors"
import { resolveCashWalletPresentationForAccount } from "@app/cash-wallet-cutover/presentation-for-account"
import { createOnChainAddress } from "@app/wallets/create-on-chain-address"
import { consumeLimiter } from "@services/rate-limit"
import { flashCheckout } from "@services/pos-on-chain/flash"

const mockFindWallet = jest.fn()
const mockFindAccount = jest.fn()
jest.mock("@services/mongoose", () => ({
  WalletsRepository: () => ({ findById: mockFindWallet }),
  AccountsRepository: () => ({ findById: mockFindAccount }),
}))
jest.mock("@app/cash-wallet-cutover/presentation-for-account", () => ({
  resolveCashWalletPresentationForAccount: jest.fn(),
}))
jest.mock("@app/wallets/create-on-chain-address", () => ({
  createOnChainAddress: jest.fn(),
}))
jest.mock("@services/rate-limit", () => ({ consumeLimiter: jest.fn() }))
jest.mock("@services/pos-on-chain/indexer", () => ({
  esploraTotals: () => async () => ({
    receivedSats: 0,
    confirmedSats: 0,
    fundedOutputs: 0,
  }),
}))
// An in-memory stand-in: this spec is about flash.ts, the Mongo store has its own.
jest.mock("@services/pos-on-chain/store", () => {
  const rows = new Map()
  return {
    posOnChainStore: {
      read: async (k: string) => rows.get(k) ?? null,
      reserve: async (row: { _id: string }) => {
        rows.set(row._id, row)
      },
      claim: async () => true,
      stage: async (k: string, _: string, candidate: string) =>
        !!rows.set(k, { ...rows.get(k), candidate }),
      discard: async () => undefined,
      publish: async (k: string, _: string, address: string) =>
        !!rows.set(k, { ...rows.get(k), address }),
      release: async () => undefined,
      clear: () => rows.clear(),
    },
  }
})

const walletId = randomUUID()
const accountId = "merchant-account"
const ip = "192.0.2.15"
const signetGenesis = "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6"
const mainnetGenesis = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"
const address = payments.p2wpkh({
  hash: Buffer.alloc(20, 7),
  network: networks.testnet,
}).address!
const env = {
  POS_ONCHAIN_NETWORK: "SIGNET",
  POS_ONCHAIN_ESPLORA: "https://esplora.example",
  POS_ONCHAIN_GENESIS: signetGenesis,
  POS_ONCHAIN_RECEIVE_WALLETS: walletId,
}
const sale = (n: number) => ({
  recipientWalletId: walletId,
  sats: 1000,
  requestId: String(n).padStart(64, "0"),
})
let n = 0
const consume = consumeLimiter as jest.Mock
const presentation = resolveCashWalletPresentationForAccount as jest.Mock
const allocate = createOnChainAddress as jest.Mock

beforeEach(() => {
  Object.assign(process.env, env)
  mockFindWallet
    .mockReset()
    .mockResolvedValue({ id: walletId, accountId, currency: "USD" })
  mockFindAccount
    .mockReset()
    .mockResolvedValue({ id: accountId, status: "active", level: 1 })
  presentation.mockReset().mockResolvedValue({ defaultWalletId: walletId })
  allocate.mockReset().mockResolvedValue(address)
  consume.mockReset().mockResolvedValue(true)
})
afterEach(() => {
  delete process.env.POS_ONCHAIN_MIN_LEVEL
})
afterAll(() => {
  for (const k of Object.keys(env)) delete process.env[k]
})

describe("flashCheckout configuration", () => {
  it("is enabled for a complete signet configuration and a localhost http indexer", () => {
    expect(flashCheckout()).not.toBeNull()
    process.env.POS_ONCHAIN_ESPLORA = "http://localhost:3002"
    expect(flashCheckout()).not.toBeNull()
  })

  it.each([
    ["no receive wallets", { POS_ONCHAIN_RECEIVE_WALLETS: "" }],
    ["no indexer", { POS_ONCHAIN_ESPLORA: "" }],
    ["no genesis", { POS_ONCHAIN_GENESIS: "" }],
    ["an unknown network", { POS_ONCHAIN_NETWORK: "LIQUID" }],
    [
      "MAINNET with a non-mainnet genesis",
      { POS_ONCHAIN_NETWORK: "MAINNET", POS_ONCHAIN_GENESIS: signetGenesis },
    ],
    [
      "an http indexer that is not localhost",
      { POS_ONCHAIN_ESPLORA: "http://esplora.example" },
    ],
  ])("is disabled with %s", (_, override) => {
    Object.assign(process.env, override)
    expect(flashCheckout()).toBeNull()
  })

  it("is enabled by a minimum level alone, with no wallet list", () => {
    Object.assign(process.env, {
      POS_ONCHAIN_RECEIVE_WALLETS: "",
      POS_ONCHAIN_MIN_LEVEL: "1",
    })
    expect(flashCheckout()).not.toBeNull()
  })

  it.each(["0", "4", "one", "-1", "1.5", ""])(
    "ignores the minimum level %p, so an empty wallet list still means off",
    (level) => {
      Object.assign(process.env, {
        POS_ONCHAIN_RECEIVE_WALLETS: "",
        POS_ONCHAIN_MIN_LEVEL: level,
      })
      expect(flashCheckout()).toBeNull()
    },
  )

  it("accepts MAINNET only with the mainnet genesis", () => {
    Object.assign(process.env, {
      POS_ONCHAIN_NETWORK: "MAINNET",
      POS_ONCHAIN_GENESIS: mainnetGenesis,
    })
    expect(flashCheckout()).not.toBeNull()
  })
})

describe("flashCheckout eligibility", () => {
  const supports = (id: string = walletId) => flashCheckout()!.supports(id)
  const ruleOnly = (level: string) =>
    Object.assign(process.env, {
      POS_ONCHAIN_RECEIVE_WALLETS: "",
      POS_ONCHAIN_MIN_LEVEL: level,
    })

  it("with only a wallet list, a listed wallet qualifies and no other does, without any lookup", async () => {
    expect(await supports()).toBe(true)
    expect(await supports(randomUUID())).toBe(false)
    expect(mockFindWallet).not.toHaveBeenCalled()
    expect(mockFindAccount).not.toHaveBeenCalled()
  })

  it.each([
    ["1", 1, true],
    ["1", 2, true],
    ["2", 1, false],
    ["2", 2, true],
    ["1", 0, false],
    ["1", undefined, false],
  ])(
    "minimum level %s: an active account at level %p qualifies = %p",
    async (min, level, expected) => {
      ruleOnly(min)
      mockFindAccount.mockResolvedValue({ id: accountId, status: "active", level })
      expect(await supports()).toBe(expected)
    },
  )

  it.each(["locked", "closed", "pending", "new"])(
    "a %s account does not qualify by level",
    async (status) => {
      ruleOnly("1")
      mockFindAccount.mockResolvedValue({ id: accountId, status, level: 2 })
      expect(await supports()).toBe(false)
    },
  )

  it("a BTC wallet does not qualify by level", async () => {
    ruleOnly("1")
    mockFindWallet.mockResolvedValue({ id: walletId, accountId, currency: "BTC" })
    expect(await supports()).toBe(false)
    expect(mockFindAccount).not.toHaveBeenCalled()
  })

  it.each([
    ["a malformed wallet id", () => undefined, "not-a-wallet-id"],
    [
      "an unknown wallet",
      () => mockFindWallet.mockResolvedValue(new Error("not found")),
      undefined,
    ],
    [
      "an unknown account",
      () => mockFindAccount.mockResolvedValue(new Error("not found")),
      undefined,
    ],
  ])("%s does not qualify, and does not throw", async (_, arrange, id) => {
    ruleOnly("1")
    arrange()
    expect(await supports(id)).toBe(false)
  })

  it("a listed wallet qualifies whatever its account's level, with the rule on", async () => {
    process.env.POS_ONCHAIN_MIN_LEVEL = "2"
    mockFindAccount.mockResolvedValue({ id: accountId, status: "active", level: 0 })
    expect(await supports()).toBe(true)
  })

  it("create refuses a wallet that does not qualify, before any limiter or allocation", async () => {
    ruleOnly("2")
    await expect(flashCheckout()!.create(sale(++n), ip)).rejects.toThrow(
      /unavailable for this wallet/,
    )
    expect(consume).not.toHaveBeenCalled()
    expect(allocate).not.toHaveBeenCalled()
  })

  it("create issues an address to a wallet that qualifies by level alone", async () => {
    ruleOnly("1")
    expect((await flashCheckout()!.create(sale(++n), ip)).address).toBe(address)
  })

  it("a merchant who is locked between two attempts at the same sale gets no address on the retry", async () => {
    ruleOnly("1")
    const again = sale(++n)
    await flashCheckout()!.create(again, ip)
    mockFindAccount.mockResolvedValue({ id: accountId, status: "locked", level: 1 })
    await expect(flashCheckout()!.create(again, ip)).rejects.toThrow(
      /unavailable for this wallet/,
    )
  })
})

describe("flashCheckout address allocation", () => {
  const create = () => flashCheckout()!.create(sale(++n), ip)

  it("allocates through Flash once every check passes", async () => {
    expect((await create()).address).toBe(address)
    expect(allocate).toHaveBeenCalledWith({ walletId })
  })

  it("refuses a BTC wallet before any limiter or allocation", async () => {
    mockFindWallet.mockResolvedValue({ id: walletId, accountId, currency: "BTC" })
    await expect(create()).rejects.toThrow(/does not support Flash custodial/)
    expect(consume).not.toHaveBeenCalled()
    expect(allocate).not.toHaveBeenCalled()
  })

  it("refuses a wallet that is no longer the merchant's default after a cutover", async () => {
    presentation.mockResolvedValue({ defaultWalletId: randomUUID() })
    await expect(create()).rejects.toThrow(/receiving wallet changed/)
    expect(allocate).not.toHaveBeenCalled()
  })

  it("maps a limiter error and allocates nothing", async () => {
    consume.mockResolvedValueOnce(new OnChainAddressCreateRateLimiterExceededError())
    await expect(create()).rejects.toThrow(/temporarily unavailable/)
    expect(allocate).not.toHaveBeenCalled()
  })

  it("charges the caller's per-merchant bucket before the merchant's own", async () => {
    await create()
    expect(consume.mock.calls).toEqual([
      [
        {
          rateLimitConfig: RateLimitConfig.posOnChainAddressCreatePerIp,
          keyToConsume: `${ip}:${accountId}`,
        },
      ],
      [
        {
          rateLimitConfig: RateLimitConfig.posOnChainAddressCreate,
          keyToConsume: accountId,
        },
      ],
    ])
    expect(RateLimitConfig.posOnChainAddressCreate.limits.blockDuration).toBe(0)
    expect(RateLimitConfig.posOnChainAddressCreate.key).not.toBe(
      RateLimitConfig.onChainAddressCreate.key,
    )
  })

  it("leaves the merchant's bucket untouched once one caller has spent theirs", async () => {
    consume.mockResolvedValueOnce(new OnChainAddressCreateRateLimiterExceededError())
    await expect(create()).rejects.toThrow(/temporarily unavailable/)
    expect(consume).toHaveBeenCalledTimes(1)
    expect(consume.mock.calls[0][0].rateLimitConfig).toBe(
      RateLimitConfig.posOnChainAddressCreatePerIp,
    )
  })
})
