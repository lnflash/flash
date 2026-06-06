import { mapAndParseErrorForGqlResponse, mapError } from "@graphql/error-map"
import {
  BridgeAccountLevelError,
  BridgeApiError,
  BridgeBelowMinimumWithdrawalError,
  BridgeCustomerNotFoundError,
  BridgeDisabledError,
  BridgeError,
  BridgeInsufficientFundsError,
  BridgeInvalidAmountError,
  BridgeKycOffboardedError,
  BridgeKycPendingError,
  BridgeKycRejectedError,
  BridgeRateLimitError,
  BridgeTimeoutError,
  BridgeTransferFailedError,
  BridgeWebhookValidationError,
} from "@services/bridge/errors"

describe("error-map: Bridge errors", () => {
  const cases: Array<[Error, string]> = [
    [new BridgeInvalidAmountError(), "BRIDGE_INVALID_AMOUNT"],
    [new BridgeBelowMinimumWithdrawalError(10), "BRIDGE_BELOW_MINIMUM_WITHDRAWAL"],
    [new BridgeDisabledError(), "BRIDGE_DISABLED"],
    [new BridgeAccountLevelError(), "BRIDGE_ACCOUNT_LEVEL_ERROR"],
    [new BridgeKycPendingError(), "BRIDGE_KYC_PENDING"],
    [new BridgeKycRejectedError(), "BRIDGE_KYC_REJECTED"],
    [new BridgeKycOffboardedError(), "BRIDGE_KYC_OFFBOARDED"],
    [new BridgeCustomerNotFoundError(), "BRIDGE_CUSTOMER_NOT_FOUND"],
    [new BridgeInsufficientFundsError(), "BRIDGE_INSUFFICIENT_FUNDS"],
    [new BridgeRateLimitError(), "BRIDGE_RATE_LIMIT"],
    [new BridgeTimeoutError(), "BRIDGE_TIMEOUT"],
    [new BridgeTransferFailedError(), "BRIDGE_TRANSFER_FAILED"],
    [new BridgeWebhookValidationError(), "BRIDGE_WEBHOOK_VALIDATION"],
    [new BridgeApiError("Bridge API error", 500), "BRIDGE_API_ERROR"],
    [new BridgeError("Bridge unavailable"), "BRIDGE_ERROR"],
  ]

  it.each(cases)("maps %p to %s", (input, expectedCode) => {
    const result = mapError(input as ApplicationError)

    expect(result.extensions.code).toBe(expectedCode)
    expect(result.extensions.code).not.toBe("INVALID_INPUT")
    expect(result.message).toBeTruthy()
  })

  it.each(cases)("parses %p into payload error code %s", (input, expectedCode) => {
    const result = mapAndParseErrorForGqlResponse(input as ApplicationError)

    expect(result.code).toBe(expectedCode)
    expect(result.code).not.toBe("INVALID_INPUT")
    expect(result.message).toBeTruthy()
  })
})
