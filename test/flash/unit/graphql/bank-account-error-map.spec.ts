import { mapAndParseErrorForGqlResponse, mapError } from "@graphql/error-map"
import { BankAccountManageRateLimiterExceededError } from "@domain/rate-limit/errors"
import {
  BankAccountCreateError,
  BankAccountDeleteError,
  BankAccountDuplicateNumberError,
  BankAccountNotOwnedError,
  BankAccountQueryError,
  BankAccountSetDefaultError,
  BankAccountUpdateError,
  BankAccountUpdateRequestCreateError,
  BankAccountUpdateRequestQueryError,
  BankAccountUpgradeRequiredError,
  BankAccountValidationError,
  BanksQueryError,
} from "@services/frappe/errors"

describe("error-map: bank account errors", () => {
  const cases: Array<[Error, string]> = [
    [new BankAccountUpgradeRequiredError(), "BANK_ACCOUNT_UPGRADE_REQUIRED"],
    [new BankAccountNotOwnedError("nope"), "BANK_ACCOUNT_NOT_FOUND"],
    [new BankAccountDuplicateNumberError("dup"), "BANK_ACCOUNT_DUPLICATE_NUMBER"],
    [new BankAccountValidationError("bad type"), "BANK_ACCOUNT_INVALID"],
    [new BankAccountCreateError("boom"), "UNEXPECTED_CLIENT_ERROR"],
    [new BankAccountUpdateError("boom"), "UNEXPECTED_CLIENT_ERROR"],
    [new BankAccountDeleteError("boom"), "UNEXPECTED_CLIENT_ERROR"],
    [new BankAccountSetDefaultError("boom"), "UNEXPECTED_CLIENT_ERROR"],
    [new BankAccountQueryError("boom"), "UNEXPECTED_CLIENT_ERROR"],
    [new BanksQueryError("boom"), "UNEXPECTED_CLIENT_ERROR"],
    [new BankAccountUpdateRequestCreateError("boom"), "UNEXPECTED_CLIENT_ERROR"],
    [new BankAccountUpdateRequestQueryError("boom"), "UNEXPECTED_CLIENT_ERROR"],
    [new BankAccountManageRateLimiterExceededError(), "TOO_MANY_REQUEST"],
  ]

  it.each(cases)("maps %p to %s", (input, expectedCode) => {
    const result = mapError(input as ApplicationError)

    expect(result.extensions.code).toBe(expectedCode)
    expect(result.message).toBeTruthy()
  })

  it.each(cases)("parses %p into payload error code %s", (input, expectedCode) => {
    const result = mapAndParseErrorForGqlResponse(input as ApplicationError)

    expect(result.code).toBe(expectedCode)
    expect(result.message).toBeTruthy()
  })

  it("tells the customer to finish upgrading when there is no ERP party", () => {
    expect(mapError(new BankAccountUpgradeRequiredError()).message).toBe(
      "Complete your account upgrade before managing bank accounts.",
    )
  })

  it("forwards ERPNext's own validation text, with a fallback", () => {
    expect(
      mapError(new BankAccountValidationError("account_type must be one of: x")).message,
    ).toBe("account_type must be one of: x")
    expect(mapError(new BankAccountValidationError("")).message).toBe(
      "The bank account details are not valid.",
    )
  })

  it("does not leak internal failure detail for generic write errors", () => {
    const result = mapError(new BankAccountCreateError("connect ECONNREFUSED 10.0.0.1"))

    expect(result.message).toBe("We could not add this bank account. Please try again.")
  })
})
