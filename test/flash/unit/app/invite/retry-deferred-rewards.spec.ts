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
})
