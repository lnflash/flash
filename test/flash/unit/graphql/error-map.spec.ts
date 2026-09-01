import { ErrorLevel } from "@domain/shared"
import { mapAndParseErrorForGqlResponse, mapError } from "@graphql/error-map"
import { PhoneAccountAlreadyExistsCannotUpgradeError } from "@services/kratos"
import {
  BridgeWithdrawalNotFoundError,
  BridgeWithdrawalAlreadyInitiatedError,
  BridgeDepositInstructionsMissingError,
} from "@services/bridge/errors"
import { IbexError, InsufficientIbexBalance } from "@services/ibex/errors"
import { PhoneCountryNotAllowedError } from "@domain/users/errors"
import { PhoneNotAllowedForRegistrationError } from "@domain/authentication/errors"
import { InvalidPhoneNumber } from "@domain/errors"

describe("error-map", () => {
  it("maps PhoneNotAllowedForRegistrationError to a user-readable validation error, not the catch-all", () => {
    const result = mapError(new PhoneNotAllowedForRegistrationError())

    expect(result.extensions.code).not.toBe("UNEXPECTED_CLIENT_ERROR")
    expect(result.message).toBe("This phone number can't be used to sign up")
  })

  it("maps BridgeWithdrawalNotFoundError to BRIDGE_WITHDRAWAL_NOT_FOUND", () => {
    const result = mapError(new BridgeWithdrawalNotFoundError())

    expect(result.extensions.code).toBe("BRIDGE_WITHDRAWAL_NOT_FOUND")
    expect(result.message).toContain("Withdrawal request not found")
  })

  it("maps BridgeWithdrawalAlreadyInitiatedError to BRIDGE_WITHDRAWAL_ALREADY_INITIATED", () => {
    const result = mapError(new BridgeWithdrawalAlreadyInitiatedError())

    expect(result.extensions.code).toBe("BRIDGE_WITHDRAWAL_ALREADY_INITIATED")
    expect(result.message).toContain("already been submitted")
  })

  it("maps BridgeDepositInstructionsMissingError to BRIDGE_DEPOSIT_INSTRUCTIONS_MISSING", () => {
    const result = mapError(new BridgeDepositInstructionsMissingError())

    expect(result.extensions.code).toBe("BRIDGE_DEPOSIT_INSTRUCTIONS_MISSING")
    expect(result.message).toContain("deposit instructions")
  })

  // A blocked auth-code destination is a policy decision, not a transient bug:
  // it must never surface as "unexpected error, please try again".
  it("maps PhoneCountryNotAllowedError to a validation error, not the catch-all", () => {
    const result = mapError(new PhoneCountryNotAllowedError())

    expect(result.message).toBe("Phone number is not from a valid region")
    expect(result.message).not.toContain("Unexpected error")
    expect(result.extensions.code).not.toBe("UNEXPECTED_CLIENT_ERROR")
  })

  // A malformed number is a client input error, and the number itself must not
  // come back inside the message.
  it("maps InvalidPhoneNumber to a validation error without echoing the number", () => {
    const result = mapError(new InvalidPhoneNumber("+000123"))

    expect(result.message).toBe("Phone number is not a valid phone number")
    expect(result.message).not.toContain("+000123")
    expect(result.extensions.code).not.toBe("UNEXPECTED_CLIENT_ERROR")
  })

  it("maps PhoneAccountAlreadyExistsCannotUpgradeError to correct GQL error", () => {
    const input = new PhoneAccountAlreadyExistsCannotUpgradeError()
    const result = mapError(input)

    expect(result).toBeDefined()
    expect(result.message).toContain("already registered")
    expect(result.extensions.code).toBe("PHONE_ALREADY_REGISTERED_TO_ANOTHER_USER")
  })

  describe("IBEX payment errors (issue #93)", () => {
    const insufficientDetail =
      "insufficient balance. Current Balance: 5.000000. Estimated Fee: 0.001109. invoice amount: 5.042164. account: 39c6e986-979b-40ab-9e7b-df18a9277a84"
    // client-facing message strips IBEX's trailing internal account UUID
    const insufficientDetailStripped =
      "insufficient balance. Current Balance: 5.000000. Estimated Fee: 0.001109. invoice amount: 5.042164"

    it("maps InsufficientIbexBalance to INSUFFICIENT_BALANCE with the IBEX detail", () => {
      const input = new InsufficientIbexBalance(
        new Error("Bad Request"),
        ErrorLevel.Info,
        insufficientDetail,
      )
      const result = mapError(input)

      expect(result.extensions.code).toBe("INSUFFICIENT_BALANCE")
      expect(result.message).toBe(insufficientDetailStripped)
      // never the internal IBEX account UUID
      expect(result.message).not.toContain("account:")
      expect(result.message).not.toContain("39c6e986-979b-40ab-9e7b-df18a9277a84")
    })

    it("maps InsufficientIbexBalance without detail to a clean fallback message", () => {
      const input = new InsufficientIbexBalance(new Error("Bad Request"))
      const result = mapError(input)

      expect(result.extensions.code).toBe("INSUFFICIENT_BALANCE")
      expect(result.message).toBe("insufficient balance")
      // never a stack trace
      expect(result.message).not.toContain("  at ")
    })

    it("surfaces INSUFFICIENT_BALANCE through mapAndParseErrorForGqlResponse", () => {
      const input = new InsufficientIbexBalance(
        new Error("Bad Request"),
        ErrorLevel.Info,
        insufficientDetail,
      )
      const result = mapAndParseErrorForGqlResponse(input)

      expect(result).toMatchObject({
        code: "INSUFFICIENT_BALANCE",
        message: insufficientDetailStripped,
      })
    })

    it("keeps other IBEX errors mapped to the generic IBEX_ERROR", () => {
      const result = mapError(new IbexError(new Error("some other 400")))

      expect(result.extensions.code).toBe("IBEX_ERROR")
      expect(result.message).toContain("An error occurred")
    })
  })
})
