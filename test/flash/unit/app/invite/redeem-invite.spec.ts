import { ValidationError } from "@domain/shared"

const mockFindOne = jest.fn()
jest.mock("@services/mongoose/models/invite", () => {
  const actual = jest.requireActual("@services/mongoose/models/invite")
  return {
    InviteMethod: actual.InviteMethod,
    InviteStatus: actual.InviteStatus,
    InviteRepository: { findOne: (...args: unknown[]) => mockFindOne(...args) },
  }
})

import { redeemInvite } from "@app/invite/redeem-invite"
import { InviteStatus } from "@services/mongoose/models/invite"

const REDEEMER = "507f1f77bcf86cd799439011"
const INVITER = "507f1f77bcf86cd799439099"
const VALID_TOKEN = "a".repeat(40)

const futureDate = () => new Date(Date.now() + 60 * 60 * 1000)
const pastDate = () => new Date(Date.now() - 60 * 60 * 1000)

describe("redeemInvite", () => {
  beforeEach(() => jest.clearAllMocks())

  it("rejects a malformed token without touching the repository", async () => {
    const result = await redeemInvite({
      accountId: REDEEMER as AccountId,
      token: "short",
    })
    expect(result).toBeInstanceOf(ValidationError)
    expect(mockFindOne).not.toHaveBeenCalled()
  })

  it("rejects an unknown token", async () => {
    mockFindOne.mockResolvedValue(null)
    const result = await redeemInvite({
      accountId: REDEEMER as AccountId,
      token: VALID_TOKEN,
    })
    expect(result).toBeInstanceOf(ValidationError)
    expect((result as ValidationError).message).toBe("Invalid invitation token")
  })

  it("rejects an already-accepted invite", async () => {
    mockFindOne.mockResolvedValue({ status: InviteStatus.ACCEPTED })
    const result = await redeemInvite({
      accountId: REDEEMER as AccountId,
      token: VALID_TOKEN,
    })
    expect(result).toBeInstanceOf(ValidationError)
    expect((result as ValidationError).message).toBe(
      "This invitation has already been used",
    )
  })

  it("expires and rejects an expired invite (persisting the EXPIRED status)", async () => {
    const save = jest.fn()
    const invite = {
      status: InviteStatus.SENT,
      expiresAt: pastDate(),
      inviterId: { toString: () => INVITER },
      save,
    }
    mockFindOne.mockResolvedValue(invite)

    const result = await redeemInvite({
      accountId: REDEEMER as AccountId,
      token: VALID_TOKEN,
    })

    expect(result).toBeInstanceOf(ValidationError)
    expect((result as ValidationError).message).toBe("This invitation has expired")
    expect(invite.status).toBe(InviteStatus.EXPIRED)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it("prevents self-redemption", async () => {
    const invite = {
      status: InviteStatus.SENT,
      expiresAt: futureDate(),
      inviterId: { toString: () => REDEEMER }, // same as redeemer
      save: jest.fn(),
    }
    mockFindOne.mockResolvedValue(invite)

    const result = await redeemInvite({
      accountId: REDEEMER as AccountId,
      token: VALID_TOKEN,
    })

    expect(result).toBeInstanceOf(ValidationError)
    expect((result as ValidationError).message).toBe(
      "You cannot redeem your own invitation",
    )
    expect(invite.save).not.toHaveBeenCalled()
  })

  it("redeems a valid pending invite", async () => {
    const save = jest.fn()
    const invite = {
      status: InviteStatus.SENT,
      expiresAt: futureDate(),
      inviterId: { toString: () => INVITER },
      save,
    } as Record<string, unknown>
    mockFindOne.mockResolvedValue(invite)

    const result = await redeemInvite({
      accountId: REDEEMER as AccountId,
      token: VALID_TOKEN,
    })

    expect(result).toBe(true)
    expect(invite.status).toBe(InviteStatus.ACCEPTED)
    expect(invite.redeemedAt).toBeInstanceOf(Date)
    expect(invite.redeemedById?.toString()).toBe(REDEEMER)
    expect(save).toHaveBeenCalledTimes(1)
  })
})
