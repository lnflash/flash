import { ValidationError } from "@domain/shared"

jest.mock("@services/mongoose/models/invite", () => {
  const actual = jest.requireActual("@services/mongoose/models/invite")
  const save = jest.fn()
  const findOne = jest.fn()
  const deleteOne = jest.fn()
  const Repo: jest.Mock & Record<string, unknown> = jest
    .fn()
    .mockImplementation((data: Record<string, unknown>) => ({
      ...data,
      _id: { toString: () => "new-invite-id" },
      save,
    })) as jest.Mock & Record<string, unknown>
  Repo.findOne = findOne
  Repo.deleteOne = deleteOne
  Repo.__save = save
  Repo.__deleteOne = deleteOne
  return {
    InviteMethod: actual.InviteMethod,
    InviteStatus: actual.InviteStatus,
    InviteRepository: Repo,
  }
})

const mockAccountFindById = jest.fn()
jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({ findById: mockAccountFindById }),
}))

const mockSendInviteNotification = jest.fn()
jest.mock("@services/notifications/invite", () => ({
  sendInviteNotification: (args: unknown) => mockSendInviteNotification(args),
}))

const mockCreateRateLimit = jest.fn()
const mockTargetRateLimit = jest.fn()
jest.mock("@app/invite/rate-limits", () => ({
  checkInviteCreateRateLimit: () => mockCreateRateLimit(),
  checkInviteTargetRateLimit: () => mockTargetRateLimit(),
}))

jest.mock("@utils", () => ({
  generateInviteToken: () => ({ token: "t".repeat(40), tokenHash: "token-hash" }),
}))

import { createInvite } from "@app/invite"
import {
  InviteMethod,
  InviteStatus,
  InviteRepository,
} from "@services/mongoose/models/invite"

const inviteRepo = InviteRepository as unknown as jest.Mock & {
  findOne: jest.Mock
  __save: jest.Mock
  __deleteOne: jest.Mock
}
const mockFindOne = inviteRepo.findOne
const mockSave = inviteRepo.__save
const mockDeleteOne = inviteRepo.__deleteOne

const ACCOUNT_ID = "507f1f77bcf86cd799439011" as AccountId
const EMAIL = "friend@example.com"

const okLimits = () => {
  mockCreateRateLimit.mockResolvedValue(true)
  mockTargetRateLimit.mockResolvedValue(true)
}

describe("createInvite", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSendInviteNotification.mockResolvedValue(true)
  })

  it("rejects an invalid contact before checking limits", async () => {
    const result = await createInvite({
      accountId: ACCOUNT_ID,
      contact: "not-an-email",
      method: InviteMethod.EMAIL,
    })
    expect(result).toBeInstanceOf(ValidationError)
    expect(mockCreateRateLimit).not.toHaveBeenCalled()
  })

  it("rejects when the daily create limit is exceeded", async () => {
    mockCreateRateLimit.mockResolvedValue(new Error("limited"))
    const result = await createInvite({
      accountId: ACCOUNT_ID,
      contact: EMAIL,
      method: InviteMethod.EMAIL,
    })
    expect(result).toBeInstanceOf(ValidationError)
    expect((result as ValidationError).message).toBe("Daily invite limit exceeded")
  })

  it("rejects when the per-contact target limit is exceeded", async () => {
    mockCreateRateLimit.mockResolvedValue(true)
    mockTargetRateLimit.mockResolvedValue(new Error("limited"))
    const result = await createInvite({
      accountId: ACCOUNT_ID,
      contact: EMAIL,
      method: InviteMethod.EMAIL,
    })
    expect(result).toBeInstanceOf(ValidationError)
    expect((result as ValidationError).message).toBe(
      "This contact has already been invited by multiple users",
    )
  })

  it("rejects a duplicate pending/sent invite from the same inviter", async () => {
    okLimits()
    mockFindOne.mockResolvedValue({ _id: "existing" })
    const result = await createInvite({
      accountId: ACCOUNT_ID,
      contact: EMAIL,
      method: InviteMethod.EMAIL,
    })
    expect(result).toBeInstanceOf(ValidationError)
    expect((result as ValidationError).message).toBe(
      "This contact has already been invited",
    )
    expect(mockSave).not.toHaveBeenCalled()
  })

  it("returns the account lookup error when the inviter is not found", async () => {
    okLimits()
    mockFindOne.mockResolvedValue(null)
    const notFound = new Error("account gone")
    mockAccountFindById.mockResolvedValue(notFound)
    const result = await createInvite({
      accountId: ACCOUNT_ID,
      contact: EMAIL,
      method: InviteMethod.EMAIL,
    })
    expect(result).toBe(notFound)
  })

  it("creates, notifies, and marks the invite as SENT on success", async () => {
    okLimits()
    mockFindOne.mockResolvedValue(null)
    mockAccountFindById.mockResolvedValue({ username: "alice" })

    const result = await createInvite({
      accountId: ACCOUNT_ID,
      contact: EMAIL,
      method: InviteMethod.EMAIL,
    })

    expect(result).not.toBeInstanceOf(Error)
    expect(result).toMatchObject({
      id: "new-invite-id",
      contact: EMAIL,
      method: InviteMethod.EMAIL,
      status: InviteStatus.SENT,
    })
    // constructed with the hashed token, PENDING first
    expect(inviteRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        contact: EMAIL,
        tokenHash: "token-hash",
        status: InviteStatus.PENDING,
      }),
    )
    // notification carries the inviter's username and the raw token
    expect(mockSendInviteNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        contact: EMAIL,
        senderName: "alice",
        token: "t".repeat(40),
      }),
    )
    // saved twice: once PENDING, once SENT
    expect(mockSave).toHaveBeenCalledTimes(2)
  })

  it("deletes the invite and returns an error when the notification fails to send", async () => {
    okLimits()
    mockFindOne.mockResolvedValue(null)
    mockAccountFindById.mockResolvedValue({ username: "alice" })
    mockSendInviteNotification.mockResolvedValue(false)

    const result = await createInvite({
      accountId: ACCOUNT_ID,
      contact: EMAIL,
      method: InviteMethod.EMAIL,
    })

    expect(result).toBeInstanceOf(ValidationError)
    expect((result as ValidationError).message).toBe(
      "Failed to send invitation — please try again",
    )
    // The doc is removed so the PENDING/SENT duplicate check can't block a retry.
    expect(mockDeleteOne).toHaveBeenCalledWith({
      _id: expect.objectContaining({ toString: expect.any(Function) }),
    })
    // Never marked SENT: only the initial PENDING save happened.
    expect(mockSave).toHaveBeenCalledTimes(1)
  })

  it("falls back to 'A friend' when the inviter has no username", async () => {
    okLimits()
    mockFindOne.mockResolvedValue(null)
    mockAccountFindById.mockResolvedValue({ username: null })

    await createInvite({
      accountId: ACCOUNT_ID,
      contact: EMAIL,
      method: InviteMethod.EMAIL,
    })

    expect(mockSendInviteNotification).toHaveBeenCalledWith(
      expect.objectContaining({ senderName: "A friend" }),
    )
  })
})
