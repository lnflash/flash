import { InvalidLnurlError } from "@domain/errors"
import { mapError } from "@graphql/error-map"

describe("error-map: external wallet errors", () => {
  it("maps InvalidLnurlError to INVALID_LNURL code", () => {
    const result = mapError(new InvalidLnurlError("bad-lnurl"))
    expect(result).toBeDefined()
    expect(result.extensions.code).toBe("INVALID_LNURL")
    expect(result.message).toBeTruthy()
  })
})
