jest.mock("@config", () => ({
  BridgeConfig: { enabled: true },
}))

jest.mock("@services/mongoose/bridge-accounts", () => ({}))

jest.mock("@services/mongoose/accounts", () => ({
  AccountsRepository: jest.fn(),
}))

jest.mock("@services/mongoose/schema", () => ({
  BridgeVirtualAccount: {},
}))

jest.mock("@services/mongoose/wallets", () => ({
  WalletsRepository: jest.fn(),
}))

jest.mock("@services/tracing", () => ({
  wrapAsyncFunctionsToRunInSpan: <F extends object>({ fns }: { fns: F }) => fns,
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@app/wallets/get-balance-for-wallet", () => ({
  getBalanceForWallet: jest.fn(),
}))

jest.mock("@app/bridge/send-withdrawal-notification", () => ({
  sendBridgeWithdrawalNotificationBestEffort: jest.fn(),
}))

jest.mock("@services/kratos", () => ({
  IdentityRepository: jest.fn(),
}))

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {},
}))

jest.mock("@services/frappe/BridgeTransferRequestWriter", () => ({
  writeBridgeCashoutPending: jest.fn(),
}))

jest.mock("@services/bridge/client", () => ({
  __esModule: true,
  default: {
    createKycLink: jest.fn(),
    getHostedKycLink: jest.fn(),
    getHostedTosLink: jest.fn(),
  },
}))
jest.mock("@services/bridge/plaid-link-token-store", () => ({
  PlaidLinkTokenStore: jest.fn(),
}))
let mockLocks = new Map<string, Promise<unknown>>()
let mockSignal = { aborted: false },
  mockCustomerSignal = { aborted: false }
const mockAcquire = (
  path: string,
  work: (signal: { aborted: boolean }) => Promise<unknown>,
) => {
  const signal = path.startsWith("locks:bridge-kyc-customer:")
    ? mockCustomerSignal
    : mockSignal
  const next = (mockLocks.get(path) ?? Promise.resolve()).then(() => work(signal))
  mockLocks.set(
    path,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}
jest.mock("@services/lock", () => ({
  LockService: () => ({
    lockAccountId: (
      id: string,
      work: (signal: { aborted: boolean }) => Promise<unknown>,
    ) => mockAcquire("account:" + id, work),
  }),
  redlock: async ({
    path,
    asyncFn,
  }: {
    path: string
    asyncFn: (signal: { aborted: boolean }) => Promise<unknown>
  }) => {
    try {
      return await mockAcquire(path, asyncFn)
    } catch (error) {
      // Match the real adapter: callback exceptions become lock errors.
      const { UnknownLockServiceError } = jest.requireActual("@domain/lock")
      return new UnknownLockServiceError(
        error instanceof Error ? error.message : "Callback failed",
      )
    }
  },
}))

import BridgeService from "@services/bridge"
import BridgeApiClient from "@services/bridge/client"
import { BridgeApiError, BridgeError } from "@services/bridge/errors"
import { AccountsRepository } from "@services/mongoose/accounts"
import { IdentityRepository } from "@services/kratos"
import { RepositoryError } from "@domain/errors"
import { baseLogger } from "@services/logger"

const ACCOUNT = "account-1" as AccountId
const IDENTITY_LINK = "https://bridge.withpersona.com/verify?token=PRIVATE_LINK"
const TERMS_LINK = "https://compliance.bridge.xyz/accept-terms-of-service?t=PRIVATE_TERMS"
let current: Record<string, unknown>
const mockFind = jest.fn()
const mockBind = jest.fn()
const mockOwners = jest.fn()
const request = (overrides: Record<string, unknown> = {}) =>
  BridgeService.initiateKyc({
    accountId: ACCOUNT,
    email: "caller@example.com",
    full_name: "Caller Name",
    type: "individual",
    ...overrides,
  })

beforeEach(() => {
  jest.resetAllMocks()
  mockLocks = new Map()
  mockSignal = { aborted: false }
  mockCustomerSignal = { aborted: false }
  current = {
    id: ACCOUNT,
    level: 1,
    kratosUserId: "identity-1",
    username: "owner",
    bridgeKycStatus: "not_started",
  }
  mockFind.mockImplementation(async () => ({ ...current }))
  mockOwners.mockImplementation(async (customer: string) =>
    current.bridgeCustomerId === customer ? [current.id] : [],
  )
  mockBind.mockImplementation(async (_id: string, customer: string) => {
    if (current.bridgeCustomerId) return new RepositoryError("Association changed")
    current.bridgeCustomerId = customer
    current.bridgeKycStatus = "open"
    return { ...current }
  })
  ;(AccountsRepository as jest.Mock).mockReturnValue({
    findById: mockFind,
    bindBridgeCustomerIfUnbound: mockBind,
    findBridgeCustomerOwners: mockOwners,
    updateBridgeFields: jest.fn(),
  })
  ;(IdentityRepository as jest.Mock).mockReturnValue({
    getIdentity: jest.fn().mockResolvedValue({ email: "verified@example.com" }),
  })
  ;(BridgeApiClient.getHostedKycLink as jest.Mock).mockResolvedValue({
    url: IDENTITY_LINK,
  })
  ;(BridgeApiClient.getHostedTosLink as jest.Mock).mockResolvedValue({ url: TERMS_LINK })
  ;(BridgeApiClient.createKycLink as jest.Mock).mockResolvedValue({
    kyc_link: IDENTITY_LINK,
    tos_link: TERMS_LINK,
    customer_id: "cust_new",
  })
})

it.each([
  "not_started",
  "incomplete",
  "awaiting_questionnaire",
  "awaiting_ubo",
  "under_review",
  "pending",
  "paused",
  "rejected",
  "offboarded",
  "open",
])(
  "retrieves current owned customer links without POST or status reset for %s",
  async (status) => {
    current.bridgeCustomerId = "cust_owned"
    current.bridgeKycStatus = status
    const result = await request({
      email: "another-customer@example.com",
      full_name: "Unrelated caller name",
    })
    expect(result).toEqual({
      customerId: "cust_owned",
      kycLink: IDENTITY_LINK,
      tosLink: TERMS_LINK,
    })
    expect(BridgeApiClient.getHostedKycLink).toHaveBeenCalledWith("cust_owned")
    expect(BridgeApiClient.getHostedTosLink).toHaveBeenCalledWith("cust_owned")
    expect(BridgeApiClient.createKycLink).not.toHaveBeenCalled()
    expect(IdentityRepository).not.toHaveBeenCalled()
    expect(mockBind).not.toHaveBeenCalled()
    expect(current.bridgeKycStatus).toBe(status)
  },
)

it("never falls back to POST when existing-link retrieval fails or returns malformed URLs", async () => {
  current.bridgeCustomerId = "cust_owned"
  ;(BridgeApiClient.getHostedKycLink as jest.Mock).mockRejectedValueOnce(
    new BridgeApiError("Provider failed", 503),
  )
  expect(await request()).toBeInstanceOf(Error)
  ;(BridgeApiClient.getHostedKycLink as jest.Mock).mockResolvedValue({
    url: "https://bridge.withpersona.com.attacker.test/secret",
  })
  expect(await request()).toBeInstanceOf(Error)
  expect(BridgeApiClient.createKycLink).not.toHaveBeenCalled()
  expect(mockBind).not.toHaveBeenCalled()
})

it("does not reveal a link if the current owned association changed during provider GET", async () => {
  current.bridgeCustomerId = "cust_owned"
  ;(BridgeApiClient.getHostedKycLink as jest.Mock).mockImplementation(async () => {
    current.bridgeCustomerId = "cust_replaced"
    return { url: IDENTITY_LINK }
  })
  expect(await request()).toBeInstanceOf(Error)
  expect(mockBind).not.toHaveBeenCalled()
  expect(BridgeApiClient.createKycLink).not.toHaveBeenCalled()
})

it("refuses caller-email duplicate-customer fallback and never logs its private response", async () => {
  ;(BridgeApiClient.createKycLink as jest.Mock).mockRejectedValue(
    new BridgeApiError("Duplicate email", 400, {
      existing_kyc_link: {
        customer_id: "cust_foreign",
        kyc_link: IDENTITY_LINK,
        tos_link: TERMS_LINK,
      },
    }),
  )
  const result = await request()
  expect(result).toBeInstanceOf(BridgeApiError)
  expect((result as BridgeApiError).response).toBeUndefined()
  expect(current.bridgeCustomerId).toBeUndefined()
  expect(mockBind).not.toHaveBeenCalled()
  expect(BridgeApiClient.getHostedKycLink).not.toHaveBeenCalled()
  const logs = JSON.stringify((baseLogger.error as jest.Mock).mock.calls)
  expect(logs).not.toContain("PRIVATE_")
  expect(logs).not.toContain("existing_kyc_link")
})

it("uses one stable per-account UUID and authoritative identity email across explicit retries", async () => {
  ;(BridgeApiClient.createKycLink as jest.Mock).mockRejectedValueOnce(
    new Error("Transport lost"),
  )
  expect(await request()).toBeInstanceOf(Error)
  expect(
    await request({ email: "different@example.com", full_name: "Changed name" }),
  ).not.toBeInstanceOf(Error)
  const calls = (BridgeApiClient.createKycLink as jest.Mock).mock.calls
  expect(calls[0][1]).toBe(calls[1][1])
  expect(calls[0][1]).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
  )
  expect(calls[0][0].email).toBe("verified@example.com")
  expect(calls[1][0].email).toBe("verified@example.com")
  expect(mockBind).toHaveBeenCalledTimes(1)
})

it("serializes concurrent starts and retrieves owned links after the first binding", async () => {
  let release: (() => void) | undefined
  ;(BridgeApiClient.createKycLink as jest.Mock).mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return { kyc_link: IDENTITY_LINK, tos_link: TERMS_LINK, customer_id: "cust_new" }
  })
  const first = request()
  for (let attempt = 0; attempt < 100 && !release; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  expect(release).toBeDefined()
  const second = request()
  release?.()
  const results = await Promise.all([first, second])
  expect(results.every((result) => !(result instanceof Error))).toBe(true)
  expect(BridgeApiClient.createKycLink).toHaveBeenCalledTimes(1)
  expect(mockBind).toHaveBeenCalledTimes(1)
  expect(BridgeApiClient.getHostedKycLink).toHaveBeenCalledWith("cust_new")
})

it("never overwrites a customer association won by another writer during first creation", async () => {
  mockBind.mockImplementation(async () => {
    current.bridgeCustomerId = "cust_other_writer"
    return new RepositoryError("Association changed")
  })
  expect(await request()).toBeInstanceOf(RepositoryError)
  expect(current.bridgeCustomerId).toBe("cust_other_writer")
  expect(mockBind).toHaveBeenCalledTimes(1)
})

it("refuses approved/low-level accounts and expired lock authority without provider calls", async () => {
  current.bridgeKycStatus = "approved"
  expect(await request()).toBeInstanceOf(Error)
  current.bridgeKycStatus = "not_started"
  current.level = 0
  expect(await request()).toBeInstanceOf(Error)
  current.level = 1
  mockSignal.aborted = true
  expect(await request()).toBeInstanceOf(Error)
  expect(BridgeApiClient.createKycLink).not.toHaveBeenCalled()
  expect(BridgeApiClient.getHostedKycLink).not.toHaveBeenCalled()
})

it.each([
  ".",
  "..",
  "",
  "cust/foreign",
  "cust?other",
  "%2e%2e",
  "cust\n",
  "é",
  "a".repeat(257),
])(
  "rejects unsafe stored customer ID before any GET, POST or binding: %s",
  async (value) => {
    current.bridgeCustomerId = value
    const result = await request()
    expect(result).toBeInstanceOf(Error)
    expect(BridgeApiClient.getHostedKycLink).not.toHaveBeenCalled()
    expect(BridgeApiClient.getHostedTosLink).not.toHaveBeenCalled()
    expect(BridgeApiClient.createKycLink).not.toHaveBeenCalled()
    expect(mockBind).not.toHaveBeenCalled()
    expect((result as Error).message).toBe("Verification request failed")
  },
)

it.each([
  ".",
  "..",
  "",
  "cust/foreign",
  "cust#hash",
  "%2e%2e",
  "cust\r\n",
  "é",
  "a".repeat(257),
])(
  "rejects unsafe newly returned customer ID before CAS or revealing links: %s",
  async (value) => {
    ;(BridgeApiClient.createKycLink as jest.Mock).mockResolvedValue({
      kyc_link: IDENTITY_LINK,
      tos_link: TERMS_LINK,
      customer_id: value,
    })
    const result = await request()
    expect(result).toBeInstanceOf(Error)
    expect(mockBind).not.toHaveBeenCalled()
    expect(current.bridgeCustomerId).toBeUndefined()
    expect((result as Error).message).toBe("Verification request failed")
    expect(JSON.stringify((baseLogger.error as jest.Mock).mock.calls)).not.toContain(
      "PRIVATE_",
    )
  },
)

it("refuses a shared historical customer association before any hosted GET", async () => {
  current.bridgeCustomerId = "cust_shared"
  mockOwners.mockResolvedValue([ACCOUNT, "another-account"])
  const result = await request()
  expect(result).toBeInstanceOf(Error)
  expect((result as Error).message).toBe("Bridge customer ownership requires review")
  expect(BridgeApiClient.getHostedKycLink).not.toHaveBeenCalled()
  expect(BridgeApiClient.getHostedTosLink).not.toHaveBeenCalled()
  expect(BridgeApiClient.createKycLink).not.toHaveBeenCalled()
  expect(mockBind).not.toHaveBeenCalled()
})
it("rechecks exclusive ownership before revealing existing links when a legacy writer adds a duplicate", async () => {
  current.bridgeCustomerId = "cust_owned"
  mockOwners
    .mockResolvedValueOnce([ACCOUNT])
    .mockResolvedValueOnce([ACCOUNT, "another-account"])
  const result = await request()
  expect(result).toBeInstanceOf(Error)
  expect((result as Error).message).toBe("Bridge customer ownership requires review")
  expect(mockOwners).toHaveBeenCalledTimes(2)
  expect(mockBind).not.toHaveBeenCalled()
})
it("refuses an initial returned customer already bound to any account before CAS", async () => {
  mockOwners.mockResolvedValue(["another-account"])
  const result = await request()
  expect(result).toBeInstanceOf(Error)
  expect(mockBind).not.toHaveBeenCalled()
  expect(current.bridgeCustomerId).toBeUndefined()
})
it("does not reveal newly created links if a legacy writer causes duplicate ownership after CAS", async () => {
  mockOwners.mockResolvedValueOnce([]).mockResolvedValueOnce([ACCOUNT, "another-account"])
  const result = await request()
  expect(result).toBeInstanceOf(Error)
  expect((result as Error).message).toBe("Bridge customer ownership requires review")
  expect(mockBind).toHaveBeenCalledTimes(1)
})
it("fails closed when owner lookup is unavailable rather than choosing an arbitrary account", async () => {
  current.bridgeCustomerId = "cust_owned"
  mockOwners.mockResolvedValue(new RepositoryError("Owner lookup unavailable"))
  expect(await request()).toBeInstanceOf(RepositoryError)
  expect(BridgeApiClient.getHostedKycLink).not.toHaveBeenCalled()
  expect(mockBind).not.toHaveBeenCalled()
})
it("sanitizes provider GET errors inside the actual callback-conversion boundary", async () => {
  current.bridgeCustomerId = "cust_owned"
  ;(BridgeApiClient.getHostedKycLink as jest.Mock).mockRejectedValue(
    new BridgeApiError("Private provider prose", 503, {
      existing_kyc_link: { kyc_link: IDENTITY_LINK },
    }),
  )
  const result = await request()
  expect(result).toBeInstanceOf(BridgeApiError)
  expect((result as BridgeApiError).statusCode).toBe(503)
  expect((result as BridgeApiError).response).toBeUndefined()
  expect((result as Error).message).not.toContain("Private")
  expect(JSON.stringify((baseLogger.error as jest.Mock).mock.calls)).not.toContain(
    "PRIVATE_LINK",
  )
})
it.each(["account", "customer"])(
  "rejects existing-link reveal when %s lock expires during final owner lookup",
  async (kind) => {
    current.bridgeCustomerId = "cust_owned"
    mockOwners.mockResolvedValueOnce([ACCOUNT]).mockImplementationOnce(async () => {
      if (kind === "account") mockSignal.aborted = true
      else mockCustomerSignal.aborted = true
      return [ACCOUNT]
    })
    const result = await request()
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toBe("Verification request lock expired")
  },
)
it.each(["account", "customer"])(
  "rejects new-link reveal when %s lock expires during final owner lookup",
  async (kind) => {
    mockOwners.mockResolvedValueOnce([]).mockImplementationOnce(async () => {
      if (kind === "account") mockSignal.aborted = true
      else mockCustomerSignal.aborted = true
      return [ACCOUNT]
    })
    const result = await request()
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toBe("Verification request lock expired")
    expect(mockBind).toHaveBeenCalledTimes(1)
  },
)
it("refuses CAS when customer lock expires during the no-owner query", async () => {
  mockOwners.mockImplementationOnce(async () => {
    mockCustomerSignal.aborted = true
    return []
  })
  const result = await request()
  expect(result).toBeInstanceOf(Error)
  expect(mockBind).not.toHaveBeenCalled()
})
it("refuses hosted GET when account lock expires during initial owner lookup", async () => {
  current.bridgeCustomerId = "cust_owned"
  mockOwners.mockImplementationOnce(async () => {
    mockSignal.aborted = true
    return [ACCOUNT]
  })
  expect(await request()).toBeInstanceOf(Error)
  expect(BridgeApiClient.getHostedKycLink).not.toHaveBeenCalled()
})

it("serializes different-account bindings for the same returned provider customer", async () => {
  const other = "account-2" as AccountId
  const records = new Map<string, Record<string, unknown>>([
    [ACCOUNT, { ...current }],
    [other, { ...current, id: other }],
  ])
  mockFind.mockImplementation(async (id: string) => ({ ...records.get(id) }))
  mockOwners.mockImplementation(async (customer: string) =>
    [...records.values()]
      .filter((record) => record.bridgeCustomerId === customer)
      .map((record) => record.id),
  )
  mockBind.mockImplementation(async (id: string, customer: string) => {
    const record = records.get(id)!
    if (record.bridgeCustomerId) return new RepositoryError("Association changed")
    record.bridgeCustomerId = customer
    return { ...record }
  })
  const results = await Promise.all([request(), request({ accountId: other })])
  expect(results.filter((result) => !(result instanceof Error))).toHaveLength(1)
  expect(results.filter((result) => result instanceof Error)).toHaveLength(1)
  expect(mockBind).toHaveBeenCalledTimes(1)
  expect(
    [...records.values()].filter((record) => record.bridgeCustomerId === "cust_new"),
  ).toHaveLength(1)
})

it("drops non-API provider exception objects instead of preserving arbitrary private fields", async () => {
  current.bridgeCustomerId = "cust_owned"
  ;(BridgeApiClient.getHostedKycLink as jest.Mock).mockRejectedValue(
    Object.assign(new BridgeError("PRIVATE_PROVIDER_PROSE"), {
      response: { kyc_link: IDENTITY_LINK },
    }),
  )
  const result = await request()
  expect(result).toBeInstanceOf(BridgeError)
  expect((result as Error).message).toBe("Verification request failed")
  expect(result).not.toHaveProperty("response")
  expect(JSON.stringify((baseLogger.error as jest.Mock).mock.calls)).not.toContain(
    "PRIVATE_",
  )
})
