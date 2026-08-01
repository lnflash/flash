import {
  INVITE_EXPIRY_HOURS,
  DAILY_INVITE_LIMIT,
  TARGET_INVITE_LIMIT,
  NEW_USER_INVITE_WINDOW_HOURS,
  INVITE_TOKEN_LENGTH,
  checkedToInviteId,
  checkedToInviteToken,
  InvalidInviteIdError,
  InviteAlreadyAcceptedError,
  InvalidExpirationDateError,
} from "@domain/invite"
import { ValidationError } from "@domain/shared"

describe("invite domain constants", () => {
  it("exposes the expected invariants", () => {
    expect(INVITE_EXPIRY_HOURS).toBe(24)
    expect(DAILY_INVITE_LIMIT).toBe(10)
    expect(TARGET_INVITE_LIMIT).toBe(3)
    expect(NEW_USER_INVITE_WINDOW_HOURS).toBe(24)
    expect(INVITE_TOKEN_LENGTH).toBe(40)
  })
})

describe("checkedToInviteId", () => {
  it("accepts a 24-character id", () => {
    const id = "507f1f77bcf86cd799439011"
    expect(checkedToInviteId(id)).toBe(id)
  })

  it.each(["", "tooshort", "507f1f77bcf86cd7994390110000"])(
    "rejects an id of the wrong length: %s",
    (id) => {
      const result = checkedToInviteId(id)
      expect(result).toBeInstanceOf(InvalidInviteIdError)
    },
  )
})

describe("checkedToInviteToken", () => {
  it("accepts a 40-char lowercase hex token", () => {
    const token = "a".repeat(40)
    expect(checkedToInviteToken(token)).toBe(token)
  })

  it("accepts uppercase hex (case-insensitive)", () => {
    const token = "AB".repeat(20)
    expect(checkedToInviteToken(token)).toBe(token)
  })

  it("rejects an empty token", () => {
    expect(checkedToInviteToken("")).toBeInstanceOf(ValidationError)
  })

  it("rejects the wrong length", () => {
    const result = checkedToInviteToken("a".repeat(39))
    expect(result).toBeInstanceOf(ValidationError)
    expect((result as ValidationError).message).toBe("Invalid invitation token length")
  })

  it("rejects non-hex characters at the right length", () => {
    const result = checkedToInviteToken("g".repeat(40))
    expect(result).toBeInstanceOf(ValidationError)
    expect((result as ValidationError).message).toBe("Invalid invitation token format")
  })
})

describe("invite domain errors", () => {
  it("are all ValidationErrors", () => {
    expect(new InvalidInviteIdError("x")).toBeInstanceOf(ValidationError)
    expect(new InviteAlreadyAcceptedError("x")).toBeInstanceOf(ValidationError)
    expect(new InvalidExpirationDateError("x")).toBeInstanceOf(ValidationError)
  })
})
