import { mapError } from "@graphql/error-map"
import { PhoneAccountAlreadyExistsCannotUpgradeError } from "@services/kratos"
import {
  BridgeWithdrawalNotFoundError,
  BridgeWithdrawalAlreadyInitiatedError,
} from "@services/bridge/errors"

describe("error-map", () => {
  it("maps BridgeWithdrawalNotFoundError to ValidationInternalError", () => {
    const result = mapError(new BridgeWithdrawalNotFoundError())

    expect(result.extensions.code).toBe("VALIDATION_ERROR")
    expect(result.message).toContain("Withdrawal request not found")
  })

  it("maps BridgeWithdrawalAlreadyInitiatedError to ValidationInternalError", () => {
    const result = mapError(new BridgeWithdrawalAlreadyInitiatedError())

    expect(result.extensions.code).toBe("VALIDATION_ERROR")
    expect(result.message).toContain("already been submitted")
  })

  it("maps PhoneAccountAlreadyExistsCannotUpgradeError to correct GQL error", () => {
    const input = new PhoneAccountAlreadyExistsCannotUpgradeError()
    const result = mapError(input)

    expect(result).toBeDefined()
    expect(result.message).toContain("already registered")
    expect(result.extensions.code).toBe("PHONE_ALREADY_REGISTERED_TO_ANOTHER_USER")
  })
})
