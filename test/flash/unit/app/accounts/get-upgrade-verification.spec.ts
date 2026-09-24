const mockGetIdVerificationByUpgradeRequest = jest.fn()
const mockGetDecisionReason = jest.fn()

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: {
    getIdVerificationByUpgradeRequest: (...args: unknown[]) =>
      mockGetIdVerificationByUpgradeRequest(...args),
    getDecisionReason: (...args: unknown[]) => mockGetDecisionReason(...args),
  },
}))

import { AccountLevel } from "@domain/accounts"
import { getUpgradeVerification } from "@app/accounts/get-upgrade-verification"
import { AccountUpgradeVerificationStatus } from "@graphql/public/types/object/account-upgrade-verification"
import {
  DecisionReasonQueryError,
  IdVerificationQueryError,
} from "@services/frappe/errors"
import {
  AccountUpgradeRequest,
  RequestStatus,
} from "@services/frappe/models/AccountUpgradeRequest"
import { baseLogger } from "@services/logger"

const makeRequest = (
  overrides: { status?: string; decisionReason?: string; reviewedAt?: Date } = {},
) =>
  new AccountUpgradeRequest(
    "AUR-0001",
    "alice" as Username,
    AccountLevel.One,
    AccountLevel.Two,
    overrides.status ?? RequestStatus.Pending,
    "Alice Applicant",
    "+18765550100" as PhoneNumber,
    "alice@example.com" as EmailAddress,
    "id_documents/alice/front.jpg",
    {
      title: "Home",
      line1: "1 Main St",
      city: "Kingston",
      state: "Kingston",
      country: "Jamaica",
    },
    0,
    undefined,
    overrides.decisionReason,
    overrides.reviewedAt,
  )

const reason = (code: string, message: string) => ({
  code,
  outcome: "resubmit",
  label: code,
  user_facing_message: message,
})

describe("getUpgradeVerification", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetIdVerificationByUpgradeRequest.mockResolvedValue(null)
    mockGetDecisionReason.mockResolvedValue(null)
  })

  it("is SUBMITTED with no reason when there is no ID Verification yet", async () => {
    const result = await getUpgradeVerification(makeRequest())
    expect(result).toEqual({
      status: "SUBMITTED",
      reasonCode: undefined,
      reasonMessage: undefined,
      reviewedAt: undefined,
    })
    expect(mockGetIdVerificationByUpgradeRequest).toHaveBeenCalledWith("AUR-0001")
    expect(mockGetDecisionReason).not.toHaveBeenCalled()
  })

  it("surfaces a resubmit request with the reason's user-facing message, never the note", async () => {
    mockGetIdVerificationByUpgradeRequest.mockResolvedValue({
      name: "IDV-1",
      status: "Resubmit requested",
      decision_reason: "RESUBMIT_BLURRY",
      reviewer_note: "internal: left edge unreadable, maybe fake",
      reviewed_at: "2026-09-02 10:00:00",
    })
    mockGetDecisionReason.mockResolvedValue(
      reason("RESUBMIT_BLURRY", "Your ID photo is too blurry to read."),
    )

    const result = await getUpgradeVerification(makeRequest())

    expect(result).toEqual({
      status: "MORE_INFO_NEEDED",
      reasonCode: "RESUBMIT_BLURRY",
      reasonMessage: "Your ID photo is too blurry to read.",
      reviewedAt: new Date("2026-09-02T10:00:00.000Z"),
    })
    expect(JSON.stringify(result)).not.toContain("internal")
    expect(mockGetDecisionReason).toHaveBeenCalledWith("RESUBMIT_BLURRY")
  })

  it("falls back to the upgrade request's own decision_reason and reviewed_at", async () => {
    mockGetDecisionReason.mockResolvedValue(
      reason("REJECT_EXPIRED_DOCUMENT", "The ID you submitted has expired."),
    )
    const result = await getUpgradeVerification(
      makeRequest({
        status: RequestStatus.Rejected,
        decisionReason: "REJECT_EXPIRED_DOCUMENT",
        reviewedAt: new Date("2026-09-03T00:00:00Z"),
      }),
    )
    expect(result).toEqual({
      status: "REJECTED",
      reasonCode: "REJECT_EXPIRED_DOCUMENT",
      reasonMessage: "The ID you submitted has expired.",
      reviewedAt: new Date("2026-09-03T00:00:00Z"),
    })
  })

  it("prefers the ID Verification's reason and reviewed_at over the request's", async () => {
    mockGetIdVerificationByUpgradeRequest.mockResolvedValue({
      name: "IDV-1",
      status: "Rejected",
      decision_reason: "REJECT_NAME_MISMATCH",
      reviewed_at: "2026-09-04 00:00:00",
    })
    mockGetDecisionReason.mockResolvedValue(reason("REJECT_NAME_MISMATCH", "Name."))
    const result = await getUpgradeVerification(
      makeRequest({
        status: RequestStatus.Rejected,
        decisionReason: "REJECT_OTHER",
        reviewedAt: new Date("2026-09-03T00:00:00Z"),
      }),
    )
    expect(result.reasonCode).toBe("REJECT_NAME_MISMATCH")
    expect(result.reviewedAt).toEqual(new Date("2026-09-04T00:00:00Z"))
    expect(mockGetDecisionReason).toHaveBeenCalledTimes(1)
    expect(mockGetDecisionReason).toHaveBeenCalledWith("REJECT_NAME_MISMATCH")
  })

  it("returns the code without a message when the reason lookup fails, and warns", async () => {
    mockGetDecisionReason.mockResolvedValue(new DecisionReasonQueryError("down"))
    const result = await getUpgradeVerification(
      makeRequest({ status: RequestStatus.Rejected, decisionReason: "REJECT_OTHER" }),
    )
    expect(result).toEqual(
      expect.objectContaining({
        status: "REJECTED",
        reasonCode: "REJECT_OTHER",
        reasonMessage: undefined,
      }),
    )
    expect(baseLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "REJECT_OTHER", upgradeRequest: "AUR-0001" }),
      expect.stringContaining("Decision Reason lookup failed"),
    )
  })

  it("returns the code without a message when the code is not in the registry", async () => {
    mockGetDecisionReason.mockResolvedValue(null)
    const result = await getUpgradeVerification(
      makeRequest({ status: RequestStatus.Rejected, decisionReason: "RETIRED_CODE" }),
    )
    expect(result.reasonCode).toBe("RETIRED_CODE")
    expect(result.reasonMessage).toBeUndefined()
    expect(baseLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "RETIRED_CODE" }),
      expect.stringContaining("no registry entry"),
    )
  })

  it("derives from the request alone when the ID Verification read fails", async () => {
    mockGetIdVerificationByUpgradeRequest.mockResolvedValue(
      new IdVerificationQueryError("down"),
    )
    const result = await getUpgradeVerification(makeRequest())
    expect(result.status).toBe("SUBMITTED")
    expect(baseLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ upgradeRequest: "AUR-0001" }),
      expect.stringContaining("ID Verification lookup failed"),
    )

    const approved = await getUpgradeVerification(
      makeRequest({ status: RequestStatus.Approved }),
    )
    expect(approved.status).toBe("APPROVED")
  })

  it("serializes every status it can return through the GraphQL enum", async () => {
    const serialize = (value: unknown) =>
      AccountUpgradeVerificationStatus.serialize(value)
    const cases: Array<[string, string | null, string]> = [
      [RequestStatus.Approved, null, "APPROVED"],
      [RequestStatus.Rejected, null, "REJECTED"],
      [RequestStatus.Pending, "Resubmit requested", "MORE_INFO_NEEDED"],
      [RequestStatus.Pending, "Ready for review", "UNDER_REVIEW"],
      [RequestStatus.Pending, "Checks unavailable", "UNDER_REVIEW"],
      [RequestStatus.Pending, "Checks pending", "SUBMITTED"],
      [RequestStatus.Pending, null, "SUBMITTED"],
    ]
    for (const [aur, idv, member] of cases) {
      mockGetIdVerificationByUpgradeRequest.mockResolvedValue(
        idv ? { name: "IDV-1", status: idv } : null,
      )
      const result = await getUpgradeVerification(makeRequest({ status: aur }))
      expect(serialize(result.status)).toBe(member)
    }
    // The assertions above are only worth something if serialize can say no.
    expect(() => serialize("under_review")).toThrow()
  })
})
