import { PaymentSendStatus } from "@domain/bitcoin/lightning"

const mockGetConfig = jest.fn()
jest.mock("@config", () => ({
  ...jest.requireActual("@config"),
  getReferralRewardConfig: (...args: unknown[]) => mockGetConfig(...args),
}))

const mockFindOne = jest.fn()
const mockFindOneAndUpdate = jest.fn()
const mockUpdateOne = jest.fn()
jest.mock("@services/mongoose/models/invite", () => {
  const actual = jest.requireActual("@services/mongoose/models/invite")
  return {
    InviteMethod: actual.InviteMethod,
    InviteStatus: actual.InviteStatus,
    InviteRepository: {
      findOne: (...a: unknown[]) => mockFindOne(...a),
      findOneAndUpdate: (...a: unknown[]) => mockFindOneAndUpdate(...a),
      updateOne: (...a: unknown[]) => mockUpdateOne(...a),
    },
  }
})

const mockNextSeq = jest.fn()
jest.mock("@services/mongoose/models/referral-reward-counter", () => ({
  nextReferralRewardSeq: (...a: unknown[]) => mockNextSeq(...a),
}))

const mockFindByRole = jest.fn()
const mockListByAccountId = jest.fn()
jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({ findByRole: (...a: unknown[]) => mockFindByRole(...a) }),
  WalletsRepository: () => ({
    listByAccountId: (...a: unknown[]) => mockListByAccountId(...a),
  }),
}))

const mockPay = jest.fn()
jest.mock("@app/payments/send-intraledger", () => ({
  intraledgerPaymentSendWalletIdForUsdWallet: (...a: unknown[]) => mockPay(...a),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}))

import { awardReferralRewardOnKycApproval } from "@app/invite/award-referral-reward"
import { baseLogger } from "@services/logger"

const INVITEE = "invitee-account-id" as AccountId
const INVITER = "inviter-account-id"
const REWARDS_ACCT = "rewards-account-id"

const DEFAULT_TIERS = [
  { upToCount: 100, amountCents: 500 },
  { upToCount: 600, amountCents: 250 },
  { upToCount: 0, amountCents: 100 },
]

const pendingInvite = () => ({
  _id: "invite-1",
  inviterId: { toString: () => INVITER },
  redeemedById: { toString: () => INVITEE },
})

const usd = (id: string) => ({ currency: "USD", id })
const btc = (id: string) => ({ currency: "BTC", id })

// Route listByAccountId(accountId) -> wallets, by account.
const walletsBy = (map: Record<string, unknown[]>) => (accountId: string) =>
  map[accountId] ?? []

const lastSet = () =>
  mockUpdateOne.mock.calls[mockUpdateOne.mock.calls.length - 1][1].$set

describe("awardReferralRewardOnKycApproval", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetConfig.mockReturnValue({ enabled: true, tiers: DEFAULT_TIERS })
    mockFindOne.mockResolvedValue(pendingInvite())
    mockFindOneAndUpdate.mockResolvedValue(pendingInvite())
    mockNextSeq.mockResolvedValue(50)
    mockFindByRole.mockResolvedValue({ id: REWARDS_ACCT })
    mockListByAccountId.mockImplementation((accountId: string) =>
      Promise.resolve(
        walletsBy({
          [REWARDS_ACCT]: [usd("rewards-usd")],
          [INVITER]: [usd("inviter-usd")],
          [INVITEE]: [usd("invitee-usd")],
        })(accountId),
      ),
    )
    mockPay.mockResolvedValue(PaymentSendStatus.Success)
  })

  it("no-ops when the feature is disabled", async () => {
    mockGetConfig.mockReturnValue({ enabled: false, tiers: DEFAULT_TIERS })
    await awardReferralRewardOnKycApproval({ accountId: INVITEE })
    expect(mockFindOne).not.toHaveBeenCalled()
    expect(mockPay).not.toHaveBeenCalled()
  })

  it("no-ops when the account redeemed no (unclaimed) invite", async () => {
    mockFindOne.mockResolvedValue(null)
    await awardReferralRewardOnKycApproval({ accountId: INVITEE })
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled()
    expect(mockPay).not.toHaveBeenCalled()
  })

  it("no-ops when the atomic claim is lost to a concurrent caller", async () => {
    mockFindOneAndUpdate.mockResolvedValue(null)
    await awardReferralRewardOnKycApproval({ accountId: INVITEE })
    expect(mockNextSeq).not.toHaveBeenCalled()
    expect(mockPay).not.toHaveBeenCalled()
  })

  it("claims the invite atomically (guarding on absent rewardStatus -> processing)", async () => {
    await awardReferralRewardOnKycApproval({ accountId: INVITEE })
    const [filter, update] = mockFindOneAndUpdate.mock.calls[0]
    expect(filter).toMatchObject({ rewardStatus: { $exists: false } })
    expect(update).toEqual({ $set: { rewardStatus: "processing" } })
  })

  it("pays both parties the tier amount and marks the invite paid", async () => {
    await awardReferralRewardOnKycApproval({ accountId: INVITEE })

    expect(mockPay).toHaveBeenCalledTimes(2)
    expect(mockPay).toHaveBeenCalledWith(
      expect.objectContaining({
        senderWalletId: "rewards-usd",
        recipientWalletId: "inviter-usd",
        amount: 500,
      }),
    )
    expect(mockPay).toHaveBeenCalledWith(
      expect.objectContaining({
        senderWalletId: "rewards-usd",
        recipientWalletId: "invitee-usd",
        amount: 500,
      }),
    )

    const set = lastSet()
    expect(set.rewardStatus).toBe("paid")
    expect(set.rewardSeq).toBe(50)
    expect(set.rewardAmountCents).toBe(500)
    expect(set.rewardedAt).toBeInstanceOf(Date)
    expect(set.inviterRewardedAt).toBeInstanceOf(Date)
    expect(set.inviteeRewardedAt).toBeInstanceOf(Date)
  })

  it("applies the tier for the assigned sequence (101 -> 250)", async () => {
    mockNextSeq.mockResolvedValue(101)
    await awardReferralRewardOnKycApproval({ accountId: INVITEE })
    expect(mockPay).toHaveBeenCalledWith(expect.objectContaining({ amount: 250 }))
    expect(lastSet().rewardAmountCents).toBe(250)
  })

  it("marks paid without paying when the amount is zero", async () => {
    mockGetConfig.mockReturnValue({ enabled: true, tiers: [] })
    await awardReferralRewardOnKycApproval({ accountId: INVITEE })
    expect(mockFindByRole).not.toHaveBeenCalled()
    expect(mockPay).not.toHaveBeenCalled()
    const set = lastSet()
    expect(set.rewardStatus).toBe("paid")
    expect(set.rewardAmountCents).toBe(0)
  })

  it("fails (no payout) when no account holds the rewards role", async () => {
    mockFindByRole.mockResolvedValue(new Error("not found"))
    await awardReferralRewardOnKycApproval({ accountId: INVITEE })
    expect(mockPay).not.toHaveBeenCalled()
    expect(lastSet().rewardStatus).toBe("failed")
  })

  it("fails (no payout) when the rewards account has no USD wallet", async () => {
    mockListByAccountId.mockImplementation((accountId: string) =>
      Promise.resolve(
        walletsBy({ [REWARDS_ACCT]: [btc("rewards-btc")] })(accountId),
      ),
    )
    await awardReferralRewardOnKycApproval({ accountId: INVITEE })
    expect(mockPay).not.toHaveBeenCalled()
    expect(lastSet().rewardStatus).toBe("failed")
  })

  it("records 'partial' when only one party has a USD wallet", async () => {
    mockListByAccountId.mockImplementation((accountId: string) =>
      Promise.resolve(
        walletsBy({
          [REWARDS_ACCT]: [usd("rewards-usd")],
          [INVITER]: [btc("inviter-btc")], // no USD wallet
          [INVITEE]: [usd("invitee-usd")],
        })(accountId),
      ),
    )
    await awardReferralRewardOnKycApproval({ accountId: INVITEE })
    expect(mockPay).toHaveBeenCalledTimes(1)
    expect(mockPay).toHaveBeenCalledWith(
      expect.objectContaining({ recipientWalletId: "invitee-usd" }),
    )
    const set = lastSet()
    expect(set.rewardStatus).toBe("partial")
    expect(set.inviteeRewardedAt).toBeInstanceOf(Date)
    expect(set.inviterRewardedAt).toBeUndefined()
  })

  it("records 'partial' when one payout errors and the other succeeds", async () => {
    mockPay
      .mockResolvedValueOnce(new Error("ibex down")) // inviter
      .mockResolvedValueOnce(PaymentSendStatus.Success) // invitee
    await awardReferralRewardOnKycApproval({ accountId: INVITEE })
    const set = lastSet()
    expect(set.rewardStatus).toBe("partial")
    expect(set.inviterRewardedAt).toBeUndefined()
    expect(set.inviteeRewardedAt).toBeInstanceOf(Date)
  })

  it("records 'failed' when both payouts error, without throwing", async () => {
    mockPay.mockResolvedValue(new Error("ibex down"))
    await expect(
      awardReferralRewardOnKycApproval({ accountId: INVITEE }),
    ).resolves.toBeUndefined()
    expect(lastSet().rewardStatus).toBe("failed")
  })

  it("treats a Pending payout as paid", async () => {
    mockPay.mockResolvedValue(PaymentSendStatus.Pending)
    await awardReferralRewardOnKycApproval({ accountId: INVITEE })
    expect(lastSet().rewardStatus).toBe("paid")
  })

  it("never throws into the KYC path on an unexpected error", async () => {
    mockFindOne.mockRejectedValue(new Error("mongo exploded"))
    await expect(
      awardReferralRewardOnKycApproval({ accountId: INVITEE }),
    ).resolves.toBeUndefined()
    expect(baseLogger.error).toHaveBeenCalled()
  })
})
