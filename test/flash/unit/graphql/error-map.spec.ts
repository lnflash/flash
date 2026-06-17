import { mapError } from "@graphql/error-map"
import { PhoneAccountAlreadyExistsCannotUpgradeError } from "@services/kratos"
import {
  BridgeWithdrawalNotFoundError,
  BridgeWithdrawalAlreadyInitiatedError,
  BridgeDepositInstructionsMissingError,
} from "@services/bridge/errors"

describe("error-map", () => {
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

  it("maps PhoneAccountAlreadyExistsCannotUpgradeError to correct GQL error", () => {
    const input = new PhoneAccountAlreadyExistsCannotUpgradeError()
    const result = mapError(input)

    expect(result).toBeDefined()
    expect(result.message).toContain("already registered")
    expect(result.extensions.code).toBe("PHONE_ALREADY_REGISTERED_TO_ANOTHER_USER")
  })
})
