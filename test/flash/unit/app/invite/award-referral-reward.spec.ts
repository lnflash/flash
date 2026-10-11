import { PaymentSendStatus } from "@domain/bitcoin/lightning"

const mockGetConfig = jest.fn()
jest.mock("@config", () => ({
  ...jest.requireActual("@config"),
  getReferralRewardConfig: (...args: unknown[]) => mockGetConfig(...args),
}))

const mockFindOne = jest.fn()
const mockFindOneAndUpdate = jest.fn()
const mockUpdateOne = jest.fn()
const mockExists = jest.fn()
jest.mock("@services/mongoose/models/invite", () => {
  const actual = jest.requireActual("@services/mongoose/models/invite")
  return {
    InviteMethod: actual.InviteMethod,
    InviteStatus: actual.InviteStatus,
    InviteRepository: {
      findOne: (...a: unknown[]) => mockFindOne(...a),
      findOneAndUpdate: (...a: unknown[]) => mockFindOneAndUpdate(...a),
      updateOne: (...a: unknown[]) => mockUpdateOne(...a),
      exists: (...a: unknown[]) => mockExists(...a),
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

const mockErpEnabled = jest.fn()
jest.mock("@app/invite/referral-settings", () => ({
  referralRewardsEnabledInErp: (...a: unknown[]) => mockErpEnabled(...a),
}))

const mockAllowlistEmpty = jest.fn()
const mockAllowlisted = jest.fn()
jest.mock("@app/invite/referral-payout-allowlist", () => ({
  referralPayoutAllowlistIsEmpty: (...a: unknown[]) => mockAllowlistEmpty(...a),
  accountAllowlistedForReferralPayout: (...a: unknown[]) => mockAllowlisted(...a),
}))

const mockRewardPush = jest.fn()
jest.mock("@app/invite/send-referral-notifications", () => ({
  sendReferralRewardNotificationBestEffort: (...a: unknown[]) => mockRewardPush(...a),
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
const usdt = (id: string) => ({ currency: "USDT", id })
const btc = (id: string) => ({ currency: "BTC", id })

// Route listByAccountId(accountId) -> wallets, by account.
const walletsBy = (map: Record<string, unknown[]>) => (accountId: string) =>
  map[accountId] ?? []

const useWallets = (map: Record<string, unknown[]>) =>
  mockListByAccountId.mockImplementation((accountId: string) =>
    Promise.resolve(walletsBy(map)(accountId)),
  )

const lastSet = () =>
  mockUpdateOne.mock.calls[mockUpdateOne.mock.calls.length - 1][1].$set

describe("awardReferralRewardOnKycApproval", () => {
  beforeEach(() => {
    mockErpEnabled.mockResolvedValue(true)
    jest.clearAllMocks()
    // Allowlist defaults: nobody listed (the prod default).
    mockAllowlistEmpty.mockResolvedValue(true)
    mockAllowlisted.mockResolvedValue(false)
    mockGetConfig.mockReturnValue({ enabled: true, tiers: DEFAULT_TIERS })
    mockExists.mockResolvedValue(null) // no prior processed invite for the account
    mockFindOne.mockResolvedValue(pendingInvite())
    mockFindOneAndUpdate.mockResolvedValue(pendingInvite())
    mockNextSeq.mockResolvedValue(50)
    mockFindByRole.mockResolvedValue({ id: REWARDS_ACCT })
    // Every account holds both wallets; USDT is the active cash wallet.
    useWallets({
      [REWARDS_ACCT]: [usd("rewards-usd"), usdt("rewards-usdt")],
      [INVITER]: [usd("inviter-usd"), usdt("inviter-usdt")],
      [INVITEE]: [usd("invitee-usd"), usdt("invitee-usdt")],
    })
    mockPay.mockResolvedValue(PaymentSendStatus.Success)
  })

  it("no-ops when the feature is disabled", async () => {
    mockGetConfig.mockReturnValue({ enabled: false, tiers: DEFAULT_TIERS })
    await awardReferralRewardOnKycApproval({ accountId: INVITEE })
    expect(mockFindOne).not.toHaveBeenCalled()
    expect(mockPay).not.toHaveBeenCalled()
    // Paused + empty allowlist: one in-memory size check, zero Mongo.
    expect(mockAllowlistEmpty).toHaveBeenCalledTimes(1)
    expect(mockAllowlisted).not.toHaveBeenCalled()
    expect(mockExists).not.toHaveBeenCalled()
  })

  it("defers (no claim, no failure mark) when the ERPNext kill switch is off", async () => {
    mockErpEnabled.mockResolvedValue(false)

    await awardReferralRewardOnKycApproval({ accountId: INVITEE })

    // Deferral means the invite is left exactly as found: unclaimed and
    // retryable. Nothing is claimed, paid, or marked failed — and the log
    // names a genuinely deferred reward (a pending invite was found first).
    expect(mockFindOne).toHaveBeenCalled()
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled()
    expect(mockPay).not.toHaveBeenCalled()
    expect(mockUpdateOne).not.toHaveBeenCalled()
    expect(baseLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: INVITEE }),
      expect.stringContaining("deferred"),
    )
  })

  it("never consults ERP or logs a deferral for a non-referred KYC approval", async () => {
    // This hook fires on EVERY Bridge KYC approval. With the switch off, an
    // ops grep for "deferred" must return only genuinely deferred rewards —
    // accounts with no invite must not touch the ERP reader or log at all.
    mockErpEnabled.mockResolvedValue(false)
    mockFindOne.mockResolvedValue(null) // not a referred user

    await awardReferralRewardOnKycApproval({ accountId: INVITEE })

    expect(mockErpEnabled).not.toHaveBeenCalled()
    expect(baseLogger.info).not.toHaveBeenCalled()
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled()
    expect(mockPay).not.toHaveBeenCalled()
  })

  it("never consults ERP when the account's reward was already processed", async () => {
    mockErpEnabled.mockResolvedValue(false)
    mockExists.mockResolvedValue({ _id: "earlier-invite" })

    await awardReferralRewardOnKycApproval({ accountId: INVITEE })

    expect(mockErpEnabled).not.toHaveBeenCalled()
    expect(baseLogger.info).not.toHaveBeenCalled()
    expect(mockPay).not.toHaveBeenCalled()
  })

  it("never pays a second reward for the same account (KYC re-approval flap)", async () => {
    // A prior invite for this account was already claimed/processed.
    mockExists.mockResolvedValue({ _id: "earlier-invite" })
    await awardReferralRewardOnKycApproval({ accountId: INVITEE })
    expect(mockExists).toHaveBeenCalledWith({
      redeemedById: INVITEE,
      rewardStatus: { $exists: true },
    })
    expect(mockFindOne).not.toHaveBeenCalled()
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled()
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

  it("claims atomically, stamping processing + rewardClaimedAt", async () => {
    await awardReferralRewardOnKycApproval({ accountId: INVITEE })
    const [filter, update] = mockFindOneAndUpdate.mock.calls[0]
    expect(filter).toMatchObject({ rewardStatus: { $exists: false } })
    expect(update).toEqual({
      $set: { rewardStatus: "processing", rewardClaimedAt: expect.any(Date) },
    })
  })

  it("pays both parties from the USDT wallet (active cash wallet) and marks paid", async () => {
    await awardReferralRewardOnKycApproval({ accountId: INVITEE })

    expect(mockPay).toHaveBeenCalledTimes(2)
    expect(mockPay).toHaveBeenCalledWith(
      expect.objectContaining({
        senderWalletId: "rewards-usdt",
        recipientWalletId: "inviter-usdt",
        amount: 500,
      }),
    )
    expect(mockPay).toHaveBeenCalledWith(
      expect.objectContaining({
        senderWalletId: "rewards-usdt",
        recipientWalletId: "invitee-usdt",
        amount: 500,
      }),
    )

    const set = lastSet()
    expect(set.rewardStatus).toBe("paid")
    // Both legs paid -> both parties get a reward push.
    expect(mockRewardPush).toHaveBeenCalledWith(
      expect.objectContaining({ leg: "inviter", amountCents: 500 }),
    )
    expect(mockRewardPush).toHaveBeenCalledWith(
      expect.objectContaining({ leg: "invitee", amountCents: 500 }),
    )
    expect(set.rewardSeq).toBe(50)
    expect(set.rewardAmountCents).toBe(500)
    expect(set.rewardedAt).toBeInstanceOf(Date)
    expect(set.inviterRewardedAt).toBeInstanceOf(Date)
    expect(set.inviteeRewardedAt).toBeInstanceOf(Date)
  })

  it("falls back to USD when the rewards account has no USDT wallet, matching recipients by USD", async () => {
    useWallets({
      [REWARDS_ACCT]: [usd("rewards-usd")],
      [INVITER]: [usd("inviter-usd"), usdt("inviter-usdt")],
      [INVITEE]: [usd("invitee-usd")],
    })
    await awardReferralRewardOnKycApproval({ accountId: INVITEE })
    expect(mockPay).toHaveBeenCalledWith(
      expect.objectContaining({
        senderWalletId: "rewards-usd",
        recipientWalletId: "inviter-usd", // matched by sender currency, not USDT
      }),
    )
    expect(mockPay).toHaveBeenCalledWith(
      expect.objectContaining({
        senderWalletId: "rewards-usd",
        recipientWalletId: "invitee-usd",
      }),
    )
    expect(lastSet().rewardStatus).toBe("paid")
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

  it("fails (no payout) when the rewards account has neither a USDT nor a USD wallet", async () => {
    useWallets({ [REWARDS_ACCT]: [btc("rewards-btc")] })
    await awardReferralRewardOnKycApproval({ accountId: INVITEE })
    expect(mockPay).not.toHaveBeenCalled()
    const set = lastSet()
    expect(set.rewardStatus).toBe("failed")
    expect(set.rewardError).toContain("USDT or USD")
  })

  it("records 'partial' when a recipient lacks a wallet in the payout currency", async () => {
    useWallets({
      [REWARDS_ACCT]: [usdt("rewards-usdt")],
      [INVITER]: [usd("inviter-usd")], // no USDT wallet -> can't receive
      [INVITEE]: [usdt("invitee-usdt")],
    })
    await awardReferralRewardOnKycApproval({ accountId: INVITEE })
    expect(mockPay).toHaveBeenCalledTimes(1)
    expect(mockPay).toHaveBeenCalledWith(
      expect.objectContaining({ recipientWalletId: "invitee-usdt" }),
    )
    const set = lastSet()
    expect(set.rewardStatus).toBe("partial")
    // Only the successfully-paid leg gets a push; the failed leg gets none.
    const pushedLegs = mockRewardPush.mock.calls.map((c) => c[0].leg)
    expect(pushedLegs).not.toContain("inviter")
    expect(set.inviteeRewardedAt).toBeInstanceOf(Date)
    expect(set.inviterRewardedAt).toBeUndefined()
    expect(set.rewardError).toContain("inviter=failed")
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

  it("records 'pending' (non-terminal) when a payout is IBEX-pending, timestamps set", async () => {
    mockPay.mockResolvedValue(PaymentSendStatus.Pending)
    await awardReferralRewardOnKycApproval({ accountId: INVITEE })
    const set = lastSet()
    expect(set.rewardStatus).toBe("pending")
    // Fail-closed: pending parties are timestamped so a re-run can't double-pay.
    expect(set.inviterRewardedAt).toBeInstanceOf(Date)
    expect(set.inviteeRewardedAt).toBeInstanceOf(Date)
    expect(set.rewardedAt).toBeUndefined()
    expect(set.rewardError).toContain("inviter=pending")
    expect(set.rewardError).toContain("invitee=pending")
    // The headline rule: pending (unconfirmed) legs never notify.
    expect(mockRewardPush).not.toHaveBeenCalled()
  })

  it("records 'pending' when one party is paid and the other IBEX-pending", async () => {
    mockPay
      .mockResolvedValueOnce(PaymentSendStatus.Success) // inviter
      .mockResolvedValueOnce(PaymentSendStatus.Pending) // invitee
    await awardReferralRewardOnKycApproval({ accountId: INVITEE })
    const set = lastSet()
    expect(set.rewardStatus).toBe("pending")
    expect(set.inviterRewardedAt).toBeInstanceOf(Date)
    expect(set.inviteeRewardedAt).toBeInstanceOf(Date)
    // Only the confirmed-paid leg notifies; the pending leg stays silent.
    const pushedLegs = mockRewardPush.mock.calls.map((c) => c[0].leg)
    expect(pushedLegs).toEqual(["inviter"])
  })

  it("records 'partial' when one party is IBEX-pending and the other fails", async () => {
    mockPay
      .mockResolvedValueOnce(PaymentSendStatus.Pending) // inviter
      .mockResolvedValueOnce(new Error("ibex down")) // invitee
    await awardReferralRewardOnKycApproval({ accountId: INVITEE })
    const set = lastSet()
    expect(set.rewardStatus).toBe("partial")
    expect(set.inviterRewardedAt).toBeInstanceOf(Date) // pending party stays timestamped
    expect(set.inviteeRewardedAt).toBeUndefined()
  })

  it("downgrades a claimed invite to 'failed' when an unexpected error follows the claim", async () => {
    mockNextSeq.mockRejectedValue(new Error("mongo hiccup"))
    await expect(
      awardReferralRewardOnKycApproval({ accountId: INVITEE }),
    ).resolves.toBeUndefined()
    const set = lastSet()
    expect(set.rewardStatus).toBe("failed")
    expect(set.rewardError).toContain("unexpected")
    expect(set.rewardSeq).toBeUndefined() // seq was never assigned
    expect(baseLogger.error).toHaveBeenCalled()
  })

  it("preserves paid-party evidence when the second payout leg throws", async () => {
    mockPay
      .mockResolvedValueOnce(PaymentSendStatus.Success) // inviter paid
      .mockRejectedValueOnce(new Error("ibex client exploded")) // invitee leg THROWS
    await expect(
      awardReferralRewardOnKycApproval({ accountId: INVITEE }),
    ).resolves.toBeUndefined()
    const set = lastSet()
    // The inviter's payment already went out: reconciliation must see it so a
    // manual re-run can't double-pay them.
    expect(set.rewardStatus).toBe("partial")
    expect(set.inviterRewardedAt).toBeInstanceOf(Date)
    expect(set.inviteeRewardedAt).toBeUndefined()
    expect(set.rewardError).toContain("unexpected")
    expect(set.rewardError).toContain("inviter=paid")
    expect(set.rewardError).toContain("invitee=failed")
    expect(set.rewardSeq).toBe(50)
  })

  it("never throws into the KYC path on an unexpected error", async () => {
    mockFindOne.mockRejectedValue(new Error("mongo exploded"))
    await expect(
      awardReferralRewardOnKycApproval({ accountId: INVITEE }),
    ).resolves.toBeUndefined()
    expect(baseLogger.error).toHaveBeenCalled()
  })
})

describe("awardReferralRewardOnKycApproval: Referral Payout Allowlist gate", () => {
  type Listed = "invitee" | "inviter" | "neither"

  const listedIds = (listed: Listed): string[] =>
    listed === "invitee" ? [INVITEE] : listed === "inviter" ? [INVITER] : []

  const setup = ({
    configEnabled,
    erpEnabled,
    allowlistEmpty,
    listed,
  }: {
    configEnabled: boolean
    erpEnabled: boolean
    allowlistEmpty: boolean
    listed: Listed
  }) => {
    mockGetConfig.mockReturnValue({ enabled: configEnabled, tiers: DEFAULT_TIERS })
    mockErpEnabled.mockResolvedValue(erpEnabled)
    mockAllowlistEmpty.mockResolvedValue(allowlistEmpty)
    const ids = allowlistEmpty ? [] : listedIds(listed)
    mockAllowlisted.mockImplementation((id: string) => Promise.resolve(ids.includes(id)))
  }

  const expectPaidBoth = () => {
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1)
    expect(mockPay).toHaveBeenCalledTimes(2)
    expect(mockPay).toHaveBeenCalledWith(
      expect.objectContaining({ recipientWalletId: "inviter-usdt", amount: 500 }),
    )
    expect(mockPay).toHaveBeenCalledWith(
      expect.objectContaining({ recipientWalletId: "invitee-usdt", amount: 500 }),
    )
    expect(lastSet().rewardStatus).toBe("paid")
  }

  const expectDeferred = (reason: string) => {
    expect(mockFindOne).toHaveBeenCalled()
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled()
    expect(mockPay).not.toHaveBeenCalled()
    expect(mockUpdateOne).not.toHaveBeenCalled()
    expect(mockNextSeq).not.toHaveBeenCalled()
    expect(baseLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: INVITEE }),
      expect.stringContaining(reason),
    )
  }

  const expectNoMongo = () => {
    expect(mockExists).not.toHaveBeenCalled()
    expect(mockFindOne).not.toHaveBeenCalled()
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled()
    expect(mockErpEnabled).not.toHaveBeenCalled()
    expect(mockPay).not.toHaveBeenCalled()
    expect(mockUpdateOne).not.toHaveBeenCalled()
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockExists.mockResolvedValue(null)
    mockFindOne.mockResolvedValue(pendingInvite())
    mockFindOneAndUpdate.mockResolvedValue(pendingInvite())
    mockNextSeq.mockResolvedValue(50)
    mockFindByRole.mockResolvedValue({ id: REWARDS_ACCT })
    useWallets({
      [REWARDS_ACCT]: [usd("rewards-usd"), usdt("rewards-usdt")],
      [INVITER]: [usd("inviter-usd"), usdt("inviter-usdt")],
      [INVITEE]: [usd("invitee-usd"), usdt("invitee-usdt")],
    })
    mockPay.mockResolvedValue(PaymentSendStatus.Success)
  })

  describe("program paused (config.enabled=false), allowlist non-empty", () => {
    it.each<Listed>(["invitee", "inviter"])(
      "%s allowlisted + ERP switch ON: pays BOTH parties per the tier",
      async (listed) => {
        setup({ configEnabled: false, erpEnabled: true, allowlistEmpty: false, listed })

        await awardReferralRewardOnKycApproval({ accountId: INVITEE })

        expect(mockErpEnabled).toHaveBeenCalled()
        expectPaidBoth()
      },
    )

    it.each<Listed>(["invitee", "inviter"])(
      "%s allowlisted + ERP switch OFF: deferred by the master switch",
      async (listed) => {
        setup({ configEnabled: false, erpEnabled: false, allowlistEmpty: false, listed })

        await awardReferralRewardOnKycApproval({ accountId: INVITEE })

        expect(mockErpEnabled).toHaveBeenCalled()
        expectDeferred("ERPNext kill switch")
      },
    )

    it.each([true, false])(
      "neither party allowlisted (ERP switch %s): deferred as not allowlisted, ERP never read",
      async (erpEnabled) => {
        setup({
          configEnabled: false,
          erpEnabled,
          allowlistEmpty: false,
          listed: "neither",
        })

        await awardReferralRewardOnKycApproval({ accountId: INVITEE })

        expect(mockAllowlisted).toHaveBeenCalledWith(INVITEE)
        expect(mockAllowlisted).toHaveBeenCalledWith(INVITER)
        expect(mockErpEnabled).not.toHaveBeenCalled()
        expectDeferred("not allowlisted")
      },
    )

    it("allowlisted invitee proceeds without consulting the inviter", async () => {
      setup({
        configEnabled: false,
        erpEnabled: true,
        allowlistEmpty: false,
        listed: "invitee",
      })

      await awardReferralRewardOnKycApproval({ accountId: INVITEE })

      expect(mockAllowlisted).toHaveBeenCalledTimes(1)
      expect(mockAllowlisted).toHaveBeenCalledWith(INVITEE)
    })

    it("allowlisted party whose account was already rewarded is never re-paid", async () => {
      setup({
        configEnabled: false,
        erpEnabled: true,
        allowlistEmpty: false,
        listed: "invitee",
      })
      mockExists.mockResolvedValue({ _id: "earlier-invite" })

      await awardReferralRewardOnKycApproval({ accountId: INVITEE })

      expect(mockFindOne).not.toHaveBeenCalled()
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled()
      expect(mockPay).not.toHaveBeenCalled()
    })

    it("allowlisted inviter + non-referred KYC approval: no log, no ERP read", async () => {
      setup({
        configEnabled: false,
        erpEnabled: true,
        allowlistEmpty: false,
        listed: "inviter",
      })
      mockFindOne.mockResolvedValue(null)

      await awardReferralRewardOnKycApproval({ accountId: INVITEE })

      expect(mockErpEnabled).not.toHaveBeenCalled()
      expect(baseLogger.info).not.toHaveBeenCalled()
      expect(mockPay).not.toHaveBeenCalled()
    })

    it("invite with no inviterId is deferred, never paid", async () => {
      setup({
        configEnabled: false,
        erpEnabled: true,
        allowlistEmpty: false,
        listed: "inviter",
      })
      mockFindOne.mockResolvedValue({ ...pendingInvite(), inviterId: undefined })

      await awardReferralRewardOnKycApproval({ accountId: INVITEE })

      expect(mockErpEnabled).not.toHaveBeenCalled()
      expectDeferred("not allowlisted")
    })

    it("allowlisted payouts advance the global tier counter", async () => {
      setup({
        configEnabled: false,
        erpEnabled: true,
        allowlistEmpty: false,
        listed: "inviter",
      })

      await awardReferralRewardOnKycApproval({ accountId: INVITEE })

      expect(mockNextSeq).toHaveBeenCalledTimes(1)
      expect(lastSet().rewardSeq).toBe(50)
    })
  })

  describe("program paused, allowlist EMPTY (prod default)", () => {
    it.each([
      [true, "invitee"],
      [false, "invitee"],
      [true, "neither"],
      [false, "neither"],
    ] as const)(
      "ERP switch %s, %s: zero Mongo, zero ERP, no pay",
      async (erpEnabled, listed) => {
        setup({ configEnabled: false, erpEnabled, allowlistEmpty: true, listed })

        await awardReferralRewardOnKycApproval({ accountId: INVITEE })

        expectNoMongo()
        expect(mockAllowlisted).not.toHaveBeenCalled()
      },
    )
  })

  describe("program enabled (config.enabled=true): allowlist is never consulted", () => {
    it.each<[boolean, Listed]>([
      [false, "neither"],
      [true, "invitee"],
      [true, "inviter"],
      [true, "neither"],
    ])(
      "allowlist non-empty=%s, listed=%s, ERP ON: pays as today",
      async (nonEmpty, listed) => {
        setup({
          configEnabled: true,
          erpEnabled: true,
          allowlistEmpty: !nonEmpty,
          listed,
        })

        await awardReferralRewardOnKycApproval({ accountId: INVITEE })

        expect(mockAllowlistEmpty).not.toHaveBeenCalled()
        expect(mockAllowlisted).not.toHaveBeenCalled()
        expectPaidBoth()
      },
    )

    it.each<Listed>(["invitee", "inviter", "neither"])(
      "listed=%s, ERP OFF: deferred by the master switch as today",
      async (listed) => {
        setup({ configEnabled: true, erpEnabled: false, allowlistEmpty: false, listed })

        await awardReferralRewardOnKycApproval({ accountId: INVITEE })

        expect(mockAllowlistEmpty).not.toHaveBeenCalled()
        expect(mockAllowlisted).not.toHaveBeenCalled()
        expectDeferred("ERPNext kill switch")
      },
    )
  })
})
