/**
 * Reconciliation sweep for referral rewards deferred by the ERPNext kill
 * switch. Covers the finding that no such sweep (nor an operator-visible
 * backlog count) existed despite the original PR's ops notes claiming one.
 */
const mockFind = jest.fn()
jest.mock("@services/mongoose/models/invite", () => {
  const actual = jest.requireActual("@services/mongoose/models/invite")
  return {
    InviteStatus: actual.InviteStatus,
    InviteRepository: {
      find: (...a: unknown[]) => mockFind(...a),
    },
  }
})

const mockAward = jest.fn()
jest.mock("@app/invite/award-referral-reward", () => ({
  awardReferralRewardOnKycApproval: (...a: unknown[]) => mockAward(...a),
}))

const mockAllowlisted = jest.fn()
jest.mock("@app/invite/referral-payout-allowlist", () => ({
  accountAllowlistedForReferralPayout: (...a: unknown[]) => mockAllowlisted(...a),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}))

import { InviteStatus } from "@domain/invite"
import { retryDeferredReferralRewards } from "@app/invite/retry-deferred-rewards"
import { baseLogger } from "@services/logger"

const deferredInvite = (redeemedById: string) => ({
  _id: `invite-${redeemedById}`,
  redeemedById: { toString: () => redeemedById },
})

describe("retryDeferredReferralRewards", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("queries the exact deferred-payout shape: ACCEPTED, unrewarded, redeemed", async () => {
    mockFind.mockResolvedValue([])
    await retryDeferredReferralRewards({ dryRun: true })
    expect(mockFind).toHaveBeenCalledWith({
      status: InviteStatus.ACCEPTED,
      rewardStatus: { $exists: false },
      redeemedById: { $exists: true },
    })
  })

  it("dry-run reports the backlog size without paying anyone", async () => {
    mockFind.mockResolvedValue([deferredInvite("acct-1"), deferredInvite("acct-2")])
    const result = await retryDeferredReferralRewards({ dryRun: true })
    expect(result).toEqual({ backlogCount: 2, accountsRetried: 0 })
    expect(mockAward).not.toHaveBeenCalled()
    expect(baseLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ backlogCount: 2, accounts: 2, dryRun: true }),
      expect.stringContaining("backlog"),
    )
  })

  it("replays the award hook once per distinct account, deduping repeat invites", async () => {
    mockFind.mockResolvedValue([
      deferredInvite("acct-1"),
      deferredInvite("acct-1"), // same account, second accepted invite
      deferredInvite("acct-2"),
    ])
    const result = await retryDeferredReferralRewards({ dryRun: false })
    expect(mockAward).toHaveBeenCalledTimes(2)
    expect(mockAward).toHaveBeenCalledWith({ accountId: "acct-1" })
    expect(mockAward).toHaveBeenCalledWith({ accountId: "acct-2" })
    expect(result).toEqual({ backlogCount: 3, accountsRetried: 2 })
  })

  it("no-ops cleanly when there is no backlog", async () => {
    mockFind.mockResolvedValue([])
    const result = await retryDeferredReferralRewards({ dryRun: false })
    expect(mockAward).not.toHaveBeenCalled()
    expect(result).toEqual({ backlogCount: 0, accountsRetried: 0 })
  })

  it("skips invites with no redeemedById rather than retrying undefined", async () => {
    mockFind.mockResolvedValue([{ _id: "invite-x", redeemedById: undefined }])
    const result = await retryDeferredReferralRewards({ dryRun: false })
    expect(mockAward).not.toHaveBeenCalled()
    expect(result).toEqual({ backlogCount: 1, accountsRetried: 0 })
  })

  describe("filtered to one account / inviter (Referral Payout Allowlist)", () => {
    const ACCOUNT = "64b7f0c2a1b2c3d4e5f60718" as AccountId
    const INVITER = "64b7f0c2a1b2c3d4e5f60719" as AccountId

    beforeEach(() => {
      mockAllowlisted.mockResolvedValue(true)
    })

    it("filters the query by redeemedById inside Mongo, not after loading", async () => {
      mockFind.mockResolvedValue([])
      await retryDeferredReferralRewards({ dryRun: true, account: ACCOUNT })
      expect(mockFind).toHaveBeenCalledWith({
        status: InviteStatus.ACCEPTED,
        rewardStatus: { $exists: false },
        redeemedById: ACCOUNT,
      })
    })

    it("filters the query by inviterId when an inviter is given", async () => {
      mockFind.mockResolvedValue([])
      await retryDeferredReferralRewards({ dryRun: true, inviter: INVITER })
      expect(mockFind).toHaveBeenCalledWith({
        status: InviteStatus.ACCEPTED,
        rewardStatus: { $exists: false },
        redeemedById: { $exists: true },
        inviterId: INVITER,
      })
    })

    it("combines both filters", async () => {
      mockFind.mockResolvedValue([])
      await retryDeferredReferralRewards({
        dryRun: true,
        account: ACCOUNT,
        inviter: INVITER,
      })
      expect(mockFind).toHaveBeenCalledWith({
        status: InviteStatus.ACCEPTED,
        rewardStatus: { $exists: false },
        redeemedById: ACCOUNT,
        inviterId: INVITER,
      })
    })

    it.each([true, false])(
      "dry-run reports whether the account is allowlisted (%s)",
      async (listed) => {
        mockAllowlisted.mockResolvedValue(listed)
        mockFind.mockResolvedValue([deferredInvite(ACCOUNT)])
        const result = await retryDeferredReferralRewards({
          dryRun: true,
          account: ACCOUNT,
        })
        expect(mockAllowlisted).toHaveBeenCalledWith(ACCOUNT)
        expect(result).toEqual({
          backlogCount: 1,
          accountsRetried: 0,
          allowlisted: listed,
        })
        expect(mockAward).not.toHaveBeenCalled()
        expect(baseLogger.info).toHaveBeenCalledWith(
          expect.objectContaining({ account: ACCOUNT, allowlisted: listed }),
          expect.stringContaining("backlog"),
        )
      },
    )

    it("reports whether the inviter is allowlisted", async () => {
      mockAllowlisted.mockResolvedValue(false)
      mockFind.mockResolvedValue([deferredInvite("acct-1")])
      const result = await retryDeferredReferralRewards({
        dryRun: true,
        inviter: INVITER,
      })
      expect(mockAllowlisted).toHaveBeenCalledWith(INVITER)
      expect(result).toEqual({
        backlogCount: 1,
        accountsRetried: 0,
        inviterAllowlisted: false,
      })
    })

    it("warns, naming the account, when the filtered backlog is empty", async () => {
      mockFind.mockResolvedValue([])
      await retryDeferredReferralRewards({ dryRun: true, account: ACCOUNT })
      expect(baseLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ account: ACCOUNT }),
        expect.stringContaining("no accepted + unrewarded invite"),
      )
    })

    it("does not warn for an empty unfiltered backlog", async () => {
      mockFind.mockResolvedValue([])
      await retryDeferredReferralRewards({ dryRun: true })
      expect(baseLogger.warn).not.toHaveBeenCalled()
      expect(mockAllowlisted).not.toHaveBeenCalled()
    })

    it("replays the award only for the filtered account", async () => {
      mockFind.mockResolvedValue([deferredInvite(ACCOUNT)])
      const result = await retryDeferredReferralRewards({
        dryRun: false,
        account: ACCOUNT,
      })
      expect(mockAward).toHaveBeenCalledTimes(1)
      expect(mockAward).toHaveBeenCalledWith({ accountId: ACCOUNT })
      expect(result).toEqual({ backlogCount: 1, accountsRetried: 1, allowlisted: true })
    })

    it("replays every invitee of the filtered inviter", async () => {
      mockFind.mockResolvedValue([deferredInvite("acct-1"), deferredInvite("acct-2")])
      const result = await retryDeferredReferralRewards({
        dryRun: false,
        inviter: INVITER,
      })
      expect(mockAward).toHaveBeenCalledTimes(2)
      expect(result).toEqual({
        backlogCount: 2,
        accountsRetried: 2,
        inviterAllowlisted: true,
      })
    })
  })
})
