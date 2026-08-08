const mockInviteFindOne = jest.fn()
const mockInviteExists = jest.fn()
jest.mock("@services/mongoose/models/invite", () => {
  const actual = jest.requireActual("@services/mongoose/models/invite")
  return {
    InviteMethod: actual.InviteMethod,
    InviteStatus: actual.InviteStatus,
    InviteRepository: {
      findOne: (...a: unknown[]) => mockInviteFindOne(...a),
      exists: (...a: unknown[]) => mockInviteExists(...a),
    },
  }
})

const mockAccountFindById = jest.fn()
const mockUserFindById = jest.fn()
jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({
    findById: (...a: unknown[]) => mockAccountFindById(...a),
  }),
  UsersRepository: () => ({ findById: (...a: unknown[]) => mockUserFindById(...a) }),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const mockAcceptedPush = jest.fn()
jest.mock("@app/invite/send-referral-notifications", () => ({
  sendInviteAcceptedNotificationBestEffort: (...a: unknown[]) => mockAcceptedPush(...a),
}))

import RedeemInviteMutation from "@graphql/public/root/mutation/redeem-invite"
import { InviteStatus } from "@services/mongoose/models/invite"

// 24-hex ids: the resolver constructs mongoose ObjectIds from them.
const REDEEMER_ACCOUNT = "507f1f77bcf86cd799439011"
const INVITER_ACCOUNT = "507f1f77bcf86cd799439022"
const TOKEN = "a".repeat(40)

type RedeemResult = { success: boolean; errors: string[] }

const ctx = {
  user: { id: "user-1" },
  domainAccount: { id: REDEEMER_ACCOUNT, username: "bob" },
} as unknown as GraphQLPublicContextAuth

const resolveRedeem = async (
  token = TOKEN,
  context: unknown = ctx,
): Promise<RedeemResult> => {
  const mutation = RedeemInviteMutation as unknown as {
    resolve: (
      source: null,
      args: { input: { token: string } },
      context: unknown,
      info: never,
    ) => Promise<RedeemResult>
  }
  return mutation.resolve(null, { input: { token } }, context, undefined as never)
}

const hourMs = 60 * 60 * 1000

const baseInvite = (overrides: Record<string, unknown> = {}) => ({
  _id: "invite-1",
  contact: "+18765550100",
  method: "WHATSAPP",
  status: InviteStatus.SENT,
  inviterId: { toString: () => INVITER_ACCOUNT },
  expiresAt: new Date(Date.now() + 12 * hourMs),
  revokedAt: undefined as Date | undefined,
  redeemedAt: undefined as Date | undefined,
  save: jest.fn(),
  ...overrides,
})

const freshAccount = () => ({ createdAt: new Date(Date.now() - 1 * hourMs) })
const staleAccount = () => ({ createdAt: new Date(Date.now() - 48 * hourMs) })

describe("redeemInvite resolver", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockInviteExists.mockResolvedValue(null) // no prior redemption
    mockAccountFindById.mockResolvedValue(freshAccount())
    mockUserFindById.mockResolvedValue({ phone: "+18765550100" })
  })

  it("rejects a malformed token without hitting the database", async () => {
    const result = await resolveRedeem("not-a-token")
    expect(result.success).toBe(false)
    expect(result.errors[0]).toMatch(/invalid invitation token/i)
    expect(mockInviteFindOne).not.toHaveBeenCalled()
  })

  it("requires an authenticated account", async () => {
    const result = await resolveRedeem(TOKEN, { user: null, domainAccount: null })
    expect(result.success).toBe(false)
    expect(result.errors[0]).toMatch(/authentication required/i)
  })

  it("rejects an unknown token", async () => {
    mockInviteFindOne.mockResolvedValue(null)
    const result = await resolveRedeem()
    expect(result).toEqual({ success: false, errors: ["Invalid or expired invitation"] })
  })

  it("expires a date-expired invite and rejects it", async () => {
    const invite = baseInvite({ expiresAt: new Date(Date.now() - hourMs) })
    mockInviteFindOne.mockResolvedValue(invite)
    const result = await resolveRedeem()
    expect(result.errors[0]).toBe("This invitation has expired")
    expect(invite.status).toBe(InviteStatus.EXPIRED)
    expect(invite.save).toHaveBeenCalled()
  })

  it("rejects an already-used invite", async () => {
    mockInviteFindOne.mockResolvedValue(baseInvite({ status: InviteStatus.ACCEPTED }))
    const result = await resolveRedeem()
    expect(result.errors[0]).toBe("This invitation has already been used")
  })

  it("does not flip an ACCEPTED invite to EXPIRED on a post-expiry replay", async () => {
    // The ACCEPTED check must precede the date-expiry flip: overwriting
    // ACCEPTED would strand the pending reward and, via the one-redemption-
    // per-account invariant, permanently cost the account its referral.
    const invite = baseInvite({
      status: InviteStatus.ACCEPTED,
      expiresAt: new Date(Date.now() - hourMs),
    })
    mockInviteFindOne.mockResolvedValue(invite)
    const result = await resolveRedeem()
    expect(result.errors[0]).toBe("This invitation has already been used")
    expect(invite.status).toBe(InviteStatus.ACCEPTED)
    expect(invite.save).not.toHaveBeenCalled()
  })

  it("rejects a revoked invite even when its expiry date is in the future", async () => {
    mockInviteFindOne.mockResolvedValue(
      baseInvite({ status: InviteStatus.EXPIRED, revokedAt: new Date() }),
    )
    const result = await resolveRedeem()
    expect(result.errors[0]).toBe("This invitation is no longer valid")
  })

  it("rejects a revokedAt-stamped invite regardless of status", async () => {
    mockInviteFindOne.mockResolvedValue(baseInvite({ revokedAt: new Date() }))
    const result = await resolveRedeem()
    expect(result.errors[0]).toBe("This invitation is no longer valid")
  })

  it("rejects self-redemption", async () => {
    mockInviteFindOne.mockResolvedValue(
      baseInvite({ inviterId: { toString: () => REDEEMER_ACCOUNT } }),
    )
    const result = await resolveRedeem()
    expect(result.errors[0]).toBe("You cannot redeem your own invitation")
  })

  it("rejects a second redemption by the same account (one reward per invitee)", async () => {
    mockInviteFindOne.mockResolvedValue(baseInvite())
    mockInviteExists.mockResolvedValue({ _id: "earlier-invite" })
    const result = await resolveRedeem()
    expect(result.errors[0]).toBe("You have already redeemed an invitation")
    const existsFilter = mockInviteExists.mock.calls[0][0]
    expect(existsFilter.status).toBe(InviteStatus.ACCEPTED)
    expect(existsFilter.redeemedById.toString()).toBe(REDEEMER_ACCOUNT)
  })

  it("treats a duplicate-key race on save as already redeemed", async () => {
    const invite = baseInvite()
    invite.save.mockRejectedValue(Object.assign(new Error("dup"), { code: 11000 }))
    mockInviteFindOne.mockResolvedValue(invite)
    const result = await resolveRedeem()
    expect(result.errors[0]).toBe("You have already redeemed an invitation")
  })

  it("rejects accounts older than the new-user window", async () => {
    mockInviteFindOne.mockResolvedValue(baseInvite())
    mockAccountFindById.mockResolvedValue(staleAccount())
    const result = await resolveRedeem()
    expect(result.errors[0]).toBe("This invitation is for new users only")
  })

  it("rejects a phone-method invite when the redeemer's phone differs", async () => {
    mockInviteFindOne.mockResolvedValue(baseInvite())
    mockUserFindById.mockResolvedValue({ phone: "+18765559999" })
    const result = await resolveRedeem()
    expect(result.errors[0]).toBe("This invitation was sent to a different phone number")
  })

  it("does not phone-match EMAIL invites (identity check deferred)", async () => {
    const invite = baseInvite({ method: "EMAIL", contact: "friend@example.com" })
    mockInviteFindOne.mockResolvedValue(invite)
    mockUserFindById.mockResolvedValue({ phone: "+18765559999" })
    const result = await resolveRedeem()
    expect(result.success).toBe(true)
  })

  it("marks the invite accepted with the redeemer on success", async () => {
    const invite = baseInvite()
    mockInviteFindOne.mockResolvedValue(invite)
    const result = await resolveRedeem()

    expect(result).toEqual({ success: true, errors: [] })
    // The inviter gets an "invite accepted" push, fire-and-forget.
    expect(mockAcceptedPush).toHaveBeenCalledWith(
      expect.objectContaining({ inviterAccountId: INVITER_ACCOUNT }),
    )
    expect(invite.status).toBe(InviteStatus.ACCEPTED)
    expect(invite.redeemedAt).toBeInstanceOf(Date)
    expect(
      (
        invite as unknown as { redeemedById: { toString(): string } }
      ).redeemedById.toString(),
    ).toBe(REDEEMER_ACCOUNT)
    expect(invite.save).toHaveBeenCalledTimes(1)
  })
})
