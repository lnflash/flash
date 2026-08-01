import { CouldNotFindError } from "@domain/errors"
import { InviteAlreadyAcceptedError, InvalidExpirationDateError } from "@domain/invite"

const mockFindById = jest.fn()
jest.mock("@services/mongoose/models/invite", () => {
  const actual = jest.requireActual("@services/mongoose/models/invite")
  return {
    InviteMethod: actual.InviteMethod,
    InviteStatus: actual.InviteStatus,
    InviteRepository: { findById: (...args: unknown[]) => mockFindById(...args) },
  }
})

const mockRedis = {
  del: jest.fn(),
  get: jest.fn(),
  ttl: jest.fn(),
  scan: jest.fn(),
}
jest.mock("@services/redis", () => ({
  redis: {
    del: (...args: unknown[]) => mockRedis.del(...args),
    get: (...args: unknown[]) => mockRedis.get(...args),
    ttl: (...args: unknown[]) => mockRedis.ttl(...args),
    scan: (...args: unknown[]) => mockRedis.scan(...args),
  },
}))

import {
  revokeInvite,
  extendInvite,
  resetInviteRateLimit,
  getInviteRateLimitStatus,
} from "@app/admin/invite"
import { InviteStatus } from "@services/mongoose/models/invite"

const INVITER = "507f1f77bcf86cd799439011"

const baseInvite = (overrides: Record<string, unknown> = {}) => ({
  _id: { toString: () => "invite-1" },
  contact: "friend@example.com",
  method: "EMAIL",
  status: InviteStatus.SENT,
  inviterId: { toString: () => INVITER },
  createdAt: new Date(),
  expiresAt: new Date(),
  revokedAt: undefined as Date | undefined,
  revokeReason: undefined as string | undefined,
  save: jest.fn(),
  ...overrides,
})

describe("admin revokeInvite", () => {
  beforeEach(() => jest.clearAllMocks())

  it("returns CouldNotFindError when missing", async () => {
    mockFindById.mockResolvedValue(null)
    expect(await revokeInvite("id" as never)).toBeInstanceOf(CouldNotFindError)
  })

  it("refuses to revoke an accepted invite", async () => {
    mockFindById.mockResolvedValue(baseInvite({ status: InviteStatus.ACCEPTED }))
    expect(await revokeInvite("id" as never)).toBeInstanceOf(InviteAlreadyAcceptedError)
  })

  it("marks the invite EXPIRED with a reason", async () => {
    const invite = baseInvite()
    mockFindById.mockResolvedValue(invite)

    const result = await revokeInvite("id" as never, "spam")

    expect(invite.status).toBe(InviteStatus.EXPIRED)
    expect(invite.revokedAt).toBeInstanceOf(Date)
    expect(invite.revokeReason).toBe("spam")
    expect(invite.save).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ id: "invite-1", status: InviteStatus.EXPIRED })
  })
})

describe("admin extendInvite", () => {
  beforeEach(() => jest.clearAllMocks())

  it("rejects a non-future expiration", async () => {
    mockFindById.mockResolvedValue(baseInvite())
    const past = new Date(Date.now() - 1000)
    expect(await extendInvite("id" as never, past)).toBeInstanceOf(
      InvalidExpirationDateError,
    )
  })

  it("refuses to extend an accepted invite", async () => {
    mockFindById.mockResolvedValue(baseInvite({ status: InviteStatus.ACCEPTED }))
    const future = new Date(Date.now() + 86_400_000)
    expect(await extendInvite("id" as never, future)).toBeInstanceOf(
      InviteAlreadyAcceptedError,
    )
  })

  it("extends and resets the invite to PENDING", async () => {
    const invite = baseInvite({ status: InviteStatus.EXPIRED })
    mockFindById.mockResolvedValue(invite)
    const future = new Date(Date.now() + 86_400_000)

    const result = await extendInvite("id" as never, future)

    expect(invite.expiresAt).toBe(future)
    expect(invite.status).toBe(InviteStatus.PENDING)
    expect(invite.save).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ status: InviteStatus.PENDING })
  })
})

describe("admin rate-limit helpers", () => {
  beforeEach(() => jest.clearAllMocks())

  it("resetInviteRateLimit deletes the account key", async () => {
    mockRedis.del.mockResolvedValue(1)
    const result = await resetInviteRateLimit(INVITER as AccountId)
    expect(result).toBe(true)
    expect(mockRedis.del).toHaveBeenCalledTimes(1)
    expect(mockRedis.del.mock.calls[0][0]).toContain(INVITER)
  })

  it("getInviteRateLimitStatus reports counts and configured limits", async () => {
    mockRedis.get.mockResolvedValue("4")
    mockRedis.ttl.mockResolvedValue(120)

    const result = await getInviteRateLimitStatus({
      accountId: INVITER as AccountId,
      contact: "+12025550123",
    })

    expect(result).toMatchObject({
      dailyCount: 4,
      dailyLimit: 10,
      targetCount: 4,
      targetLimit: 3,
      dailyTtl: 120,
      targetTtl: 120,
    })
  })
})
