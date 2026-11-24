import {
  AUTO_LOCK_COMMENT_PREFIX,
  AbuseStrikeReasons,
  recordAbuseStrike,
} from "@app/accounts/record-abuse-strike"

import {
  RateLimiterExceededError,
  UnknownRateLimitServiceError,
} from "@domain/rate-limit/errors"
import { UnknownRepositoryError } from "@domain/errors"

const mockMode = jest.fn<SendGuardMode, []>(() => "enforce")
jest.mock("@config", () => ({
  ...jest.requireActual("@config"),
  getAbuseAutoLockMode: () => mockMode(),
  getAbuseStrikeLimits: () => ({ points: 1, duration: 3600, blockDuration: 3600 }),
}))

const mockConsume = jest.fn()
jest.mock("@services/rate-limit", () => ({
  RedisRateLimitService: () => ({ consume: (key: string) => mockConsume(key) }),
}))

const mockFindById = jest.fn()
jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({ findById: (id: string) => mockFindById(id) }),
}))

const mockRevokeAll = jest.fn()
jest.mock("@services/mongoose/api-keys", () => ({
  ApiKeysRepository: () => ({ revokeAll: (id: string) => mockRevokeAll(id) }),
}))

const mockUpdateAccountStatus = jest.fn()
jest.mock("@app/accounts/update-account-status", () => ({
  updateAccountStatus: (args: unknown) => mockUpdateAccountStatus(args),
}))

const mockNotifyOpsEvent = jest.fn()
jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: (event: unknown) => mockNotifyOpsEvent(event),
}))

const mockRecordException = jest.fn()
jest.mock("@services/tracing", () => ({
  recordExceptionInCurrentSpan: (args: unknown) => mockRecordException(args),
}))

const accountId = "account-id" as AccountId
const strike = () =>
  recordAbuseStrike({ accountId, reason: AbuseStrikeReasons.invalidSendAmount })

describe("recordAbuseStrike", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockMode.mockReturnValue("enforce")
    mockConsume.mockResolvedValue(new RateLimiterExceededError())
    mockFindById.mockResolvedValue({ id: accountId, status: "active" })
    mockUpdateAccountStatus.mockResolvedValue({ id: accountId, status: "locked" })
    mockRevokeAll.mockResolvedValue(2)
  })

  it("only counts a strike that is under the threshold", async () => {
    mockConsume.mockResolvedValue(true)

    expect(await strike()).toBe("counted")
    expect(mockConsume).toHaveBeenCalledWith(accountId)
    expect(mockUpdateAccountStatus).not.toHaveBeenCalled()
    expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
  })

  it("locks, revokes the API keys and tells ops once the threshold is crossed", async () => {
    expect(await strike()).toBe("locked")

    expect(mockUpdateAccountStatus).toHaveBeenCalledWith({
      id: accountId,
      status: "locked",
      comment: expect.stringMatching(
        new RegExp(`^${AUTO_LOCK_COMMENT_PREFIX} repeated invalid-send-amount`),
      ),
    })
    expect(mockRevokeAll).toHaveBeenCalledWith(accountId)
    expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "auto-locked",
        status: "failed",
        accountId,
        step: "invalid-send-amount",
        meta: { mode: "enforce", apiKeysRevoked: "2" },
      }),
    )
  })

  it.each(["locked", "closed"])(
    "leaves an account that is already %s alone",
    async (status) => {
      mockFindById.mockResolvedValue({ id: accountId, status })

      expect(await strike()).toBe("already-inactive")
      expect(mockUpdateAccountStatus).not.toHaveBeenCalled()
      expect(mockRevokeAll).not.toHaveBeenCalled()
      expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
    },
  )

  describe("log-only", () => {
    beforeEach(() => mockMode.mockReturnValue("log-only"))

    it("reports would-auto-lock and locks nothing", async () => {
      expect(await strike()).toBe("would-lock")

      expect(mockUpdateAccountStatus).not.toHaveBeenCalled()
      expect(mockRevokeAll).not.toHaveBeenCalled()
      expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: "would-auto-lock",
          status: "pending",
          accountId,
          meta: { mode: "log-only" },
        }),
      )
    })
  })

  describe("off", () => {
    beforeEach(() => mockMode.mockReturnValue("off"))

    it("does not even count", async () => {
      expect(await strike()).toBe("off")
      expect(mockConsume).not.toHaveBeenCalled()
    })
  })

  describe("faults never reach the caller", () => {
    it("a Redis fault is recorded and locks nobody", async () => {
      mockConsume.mockResolvedValue(new UnknownRateLimitServiceError("down"))

      expect(await strike()).toBe("failed")
      expect(mockUpdateAccountStatus).not.toHaveBeenCalled()
      expect(mockRecordException).toHaveBeenCalledTimes(1)
    })

    it("a failed lock is recorded and no keys are revoked", async () => {
      mockUpdateAccountStatus.mockResolvedValue(new UnknownRepositoryError("down"))

      expect(await strike()).toBe("failed")
      expect(mockRevokeAll).not.toHaveBeenCalled()
      expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
    })

    it("a failed key revoke is recorded but the lock still stands and is reported", async () => {
      mockRevokeAll.mockResolvedValue(new UnknownRepositoryError("down"))

      expect(await strike()).toBe("locked")
      expect(mockRecordException).toHaveBeenCalledTimes(1)
      expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: "auto-locked",
          meta: { mode: "enforce", apiKeysRevoked: "failed" },
        }),
      )
    })

    it("a thrown error is caught", async () => {
      mockConsume.mockRejectedValue(new Error("boom"))

      expect(await strike()).toBe("failed")
    })
  })
})
