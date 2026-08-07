const mockGetMyReferralStats = jest.fn()
const mockListInvites = jest.fn()
jest.mock("@app/invite", () => ({
  getMyReferralStats: (...a: unknown[]) => mockGetMyReferralStats(...a),
  listInvites: (...a: unknown[]) => mockListInvites(...a),
}))

import MyReferralsQuery from "@graphql/public/root/query/my-referrals"
import { InviteStatus } from "@services/mongoose/models/invite"

const CALLER = "507f1f77bcf86cd799439011"

const ctx = {
  user: { id: "user-1" },
  domainAccount: { id: CALLER, username: "alice" },
} as unknown as GraphQLPublicContextAuth

type Result = {
  totalInvites: number
  acceptedCount: number
  totalEarnedCents: number
  pendingRewardCount: number
  invites: {
    id: string
    status: string
    myRewardCents: number | null
    rewardPending: boolean
    createdAt: string | null
    redeemedAt: string | null
  }[]
}

const resolveQuery = async (
  args: { first?: number; afterId?: string } = {},
  context: unknown = ctx,
): Promise<Result> => {
  const query = MyReferralsQuery as unknown as {
    resolve: (
      source: null,
      args: { first?: number; afterId?: string },
      context: unknown,
      info: never,
    ) => Promise<Result>
  }
  return query.resolve(null, args, context, undefined as never)
}

const STATS = {
  totalInvites: 3,
  acceptedCount: 2,
  totalEarnedCents: 500,
  pendingRewardCount: 1,
}

describe("myReferrals query", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetMyReferralStats.mockResolvedValue(STATS)
    mockListInvites.mockResolvedValue({ data: [], count: [{ total: 0 }] })
  })

  it("scopes both the stats and the list to the caller's account", async () => {
    await resolveQuery()
    expect(mockGetMyReferralStats).toHaveBeenCalledWith(CALLER)
    expect(mockListInvites).toHaveBeenCalledWith(
      expect.objectContaining({ inviterId: CALLER }),
    )
    // The caller can never pass someone else's inviterId — there is no such arg.
  })

  it("returns the aggregate stats verbatim", async () => {
    const out = await resolveQuery()
    expect(out.totalInvites).toBe(3)
    expect(out.acceptedCount).toBe(2)
    expect(out.totalEarnedCents).toBe(500)
    expect(out.pendingRewardCount).toBe(1)
  })

  it("maps a paid referral: myRewardCents set, not pending", async () => {
    mockListInvites.mockResolvedValue({
      data: [
        {
          id: "i-paid",
          contact: "friend@x.com",
          method: "EMAIL",
          status: InviteStatus.ACCEPTED,
          createdAt: new Date("2026-08-01T00:00:00Z"),
          redeemedAt: new Date("2026-08-02T00:00:00Z"),
          rewardAmountCents: 500,
          inviterRewardedAt: new Date("2026-08-03T00:00:00Z"),
        },
      ],
      count: [{ total: 1 }],
    })
    const out = await resolveQuery()
    expect(out.invites).toHaveLength(1)
    const inv = out.invites[0]
    expect(inv.myRewardCents).toBe(500)
    expect(inv.rewardPending).toBe(false)
    expect(inv.createdAt).toBe("2026-08-01T00:00:00.000Z")
    expect(inv.redeemedAt).toBe("2026-08-02T00:00:00.000Z")
  })

  it("maps an accepted-but-unpaid referral as pending with no amount", async () => {
    mockListInvites.mockResolvedValue({
      data: [
        {
          id: "i-pending",
          contact: "+18765550000",
          method: "WHATSAPP",
          status: InviteStatus.ACCEPTED,
          createdAt: new Date("2026-08-01T00:00:00Z"),
          redeemedAt: new Date("2026-08-02T00:00:00Z"),
          // rewardAmountCents may already be stamped by a partial payout —
          // the caller's leg hasn't paid, so it must NOT show as earned.
          rewardAmountCents: 500,
          inviterRewardedAt: undefined,
        },
      ],
      count: [{ total: 1 }],
    })
    const out = await resolveQuery()
    const inv = out.invites[0]
    expect(inv.myRewardCents).toBeNull()
    expect(inv.rewardPending).toBe(true)
  })

  it("zero-tier claim (paid, 0 cents, no inviter leg) is DONE — never pending", async () => {
    // award-referral-reward's zero-tier branch terminates a claim as
    // rewardStatus "paid" with rewardAmountCents 0 and NO inviterRewardedAt —
    // the designed outcome for every referral past a capped promo schedule.
    mockListInvites.mockResolvedValue({
      data: [
        {
          id: "i-zero",
          contact: "late@x.com",
          method: "EMAIL",
          status: InviteStatus.ACCEPTED,
          createdAt: new Date("2026-08-01T00:00:00Z"),
          redeemedAt: new Date("2026-08-02T00:00:00Z"),
          rewardStatus: "paid",
          rewardAmountCents: 0,
          inviterRewardedAt: undefined,
        },
      ],
      count: [{ total: 1 }],
    })
    const out = await resolveQuery()
    const inv = out.invites[0]
    expect(inv.rewardPending).toBe(false)
    expect(inv.myRewardCents).toBeNull()
  })

  it("maps a sent-not-redeemed invite: not pending, no amount, no redeemedAt", async () => {
    mockListInvites.mockResolvedValue({
      data: [
        {
          id: "i-sent",
          contact: "someone@x.com",
          method: "EMAIL",
          status: InviteStatus.SENT,
          createdAt: new Date("2026-08-04T00:00:00Z"),
        },
      ],
      count: [{ total: 1 }],
    })
    const out = await resolveQuery()
    const inv = out.invites[0]
    expect(inv.rewardPending).toBe(false)
    expect(inv.myRewardCents).toBeNull()
    expect(inv.redeemedAt).toBeNull()
  })

  it("clamps the page size into [1, 100]", async () => {
    await resolveQuery({ first: 100000 })
    expect(mockListInvites).toHaveBeenCalledWith(expect.objectContaining({ first: 100 }))
    await resolveQuery({ first: -5 })
    expect(mockListInvites).toHaveBeenCalledWith(expect.objectContaining({ first: 1 }))
    await resolveQuery({})
    expect(mockListInvites).toHaveBeenCalledWith(expect.objectContaining({ first: 20 }))
  })

  it("passes the afterId cursor through", async () => {
    await resolveQuery({ afterId: "662f000000000000000000aa" })
    expect(mockListInvites).toHaveBeenCalledWith(
      expect.objectContaining({ afterId: "662f000000000000000000aa" }),
    )
  })

  it("throws a mapped error when the stats lookup fails", async () => {
    mockGetMyReferralStats.mockResolvedValue(new Error("boom"))
    await expect(resolveQuery()).rejects.toBeDefined()
    // The two reads run in parallel (one screen-load latency), so the list
    // read fires regardless of the stats outcome.
    expect(mockListInvites).toHaveBeenCalled()
  })

  it("throws a mapped error when the list lookup fails", async () => {
    mockListInvites.mockResolvedValue(new Error("boom"))
    await expect(resolveQuery()).rejects.toBeDefined()
  })
})
