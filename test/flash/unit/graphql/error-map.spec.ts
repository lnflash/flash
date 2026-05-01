import { mapError } from "@graphql/error-map"
import { PhoneAccountAlreadyExistsCannotUpgradeError } from "@services/kratos"

describe("error-map", () => {
  it("maps PhoneAccountAlreadyExistsCannotUpgradeError to correct GQL error", () => {
    const input = new PhoneAccountAlreadyExistsCannotUpgradeError()
    const result = mapError(input)

    expect(result).toBeDefined()
    expect(result.message).toContain("already registered")
    expect(result.code).toBe("PHONE_ALREADY_REGISTERED_TO_ANOTHER_USER")
  })
})
