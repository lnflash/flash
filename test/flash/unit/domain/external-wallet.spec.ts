import { InvalidLnurlError } from "@domain/errors"
import { ValidationError } from "@domain/shared"
import { checkedToLunurl } from "@domain/wallets"

const VALID_LNURL = "LNURL1DP68GURN8GHJ7MRWW4EXCTNZD9NHXATW9EU8J730D3H82UNV94MKJ4RF9DZ"
const VALID_LNURL_LOWER = VALID_LNURL.toLowerCase()

describe("checkedToLunurl", () => {
  it("accepts a valid uppercase LNURL", () => {
    const result = checkedToLunurl(VALID_LNURL)
    expect(result).toBe(VALID_LNURL)
  })

  it("accepts a valid lowercase lnurl", () => {
    const result = checkedToLunurl(VALID_LNURL_LOWER)
    expect(result).toBe(VALID_LNURL_LOWER)
  })

  it("returns InvalidLnurlError for a plain https URL", () => {
    const result = checkedToLunurl("https://example.com/.well-known/lnurlp/alice")
    expect(result).toBeInstanceOf(InvalidLnurlError)
    expect(result).toBeInstanceOf(ValidationError)
  })

  it("returns InvalidLnurlError for an empty string", () => {
    const result = checkedToLunurl("")
    expect(result).toBeInstanceOf(InvalidLnurlError)
  })

  it("returns InvalidLnurlError for a bare 'lnurl' with no data", () => {
    const result = checkedToLunurl("lnurl")
    expect(result).toBeInstanceOf(InvalidLnurlError)
  })

  it("returns InvalidLnurlError for a lightning invoice (lnbc…)", () => {
    const result = checkedToLunurl("lnbc1000n1pjqm...")
    expect(result).toBeInstanceOf(InvalidLnurlError)
  })
})

describe("InvalidLnurlError", () => {
  it("is a ValidationError", () => {
    const err = new InvalidLnurlError()
    expect(err).toBeInstanceOf(ValidationError)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("InvalidLnurlError")
  })
})
