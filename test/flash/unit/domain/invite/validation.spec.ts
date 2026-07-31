import {
  validateEmail,
  validatePhone,
  validateContactForMethod,
} from "@domain/invite/validation"
import { InviteMethod } from "@services/mongoose/models/invite"
import { ValidationError } from "@domain/shared"

describe("invite validation", () => {
  describe("validateEmail", () => {
    it.each([
      "test@example.com",
      "a@b.co",
      "user.name+tag@sub.domain.io",
      "UPPER@Case.COM",
    ])("accepts valid email %s", (email) => {
      expect(validateEmail(email)).toBe(true)
    })

    it.each([
      "plainaddress",
      "no@domainwithoutdot",
      "@no-local.com",
      "missing@dot",
      "a@.co",
      "spaces in@email.com",
      "trailing@space.com ",
      "",
    ])("rejects invalid email %s", (email) => {
      expect(validateEmail(email)).toBe(false)
    })
  })

  describe("validatePhone", () => {
    it.each(["+12025550123", "+18765551234", "+447911123456", "+12345678"])(
      "accepts valid E.164 phone %s",
      (phone) => {
        expect(validatePhone(phone)).toBe(true)
      },
    )

    it.each([
      "12025550123", // missing +
      "+0123456789", // leading zero after +
      "+123", // too short
      "+1202555012a", // non-digit
      "+1 202 555 0123", // spaces
      "++12025550123", // double plus
      "",
    ])("rejects invalid phone %s", (phone) => {
      expect(validatePhone(phone)).toBe(false)
    })
  })

  describe("validateContactForMethod", () => {
    it("accepts a valid email for EMAIL", () => {
      expect(validateContactForMethod("test@example.com", InviteMethod.EMAIL)).toBe(true)
    })

    it("rejects an invalid email for EMAIL with a ValidationError", () => {
      const result = validateContactForMethod("nope", InviteMethod.EMAIL)
      expect(result).toBeInstanceOf(ValidationError)
      expect((result as ValidationError).message).toBe("Invalid email format")
    })

    it("accepts a valid phone for SMS and WHATSAPP", () => {
      expect(validateContactForMethod("+12025550123", InviteMethod.SMS)).toBe(true)
      expect(validateContactForMethod("+12025550123", InviteMethod.WHATSAPP)).toBe(true)
    })

    it("rejects an invalid phone for SMS/WHATSAPP with a ValidationError", () => {
      const result = validateContactForMethod("12025550123", InviteMethod.WHATSAPP)
      expect(result).toBeInstanceOf(ValidationError)
      expect((result as ValidationError).message).toBe("Invalid phone number format")
    })

    it("rejects an unknown method with a ValidationError", () => {
      const result = validateContactForMethod(
        "test@example.com",
        "CARRIER_PIGEON" as InviteMethod,
      )
      expect(result).toBeInstanceOf(ValidationError)
      expect((result as ValidationError).message).toBe("Invalid invite method")
    })

    it("does not accept an email when the method is a phone method", () => {
      expect(validateContactForMethod("test@example.com", InviteMethod.SMS)).toBeInstanceOf(
        ValidationError,
      )
    })
  })
})
