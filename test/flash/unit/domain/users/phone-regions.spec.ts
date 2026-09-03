import { countriesForCallingCode } from "@domain/users/phone-regions"

// Shared by the auth destination check and the Bridge KYC gate: the set of
// regions a calling code could denote, for numbers libphonenumber parses but
// cannot attribute (~340 assigned NANP area codes, the UK 07700 900xxx range).
describe("countriesForCallingCode", () => {
  it("returns every NANP region for +1, US and its territories included", () => {
    const regions = countriesForCallingCode("1")

    expect(regions).toEqual(
      expect.arrayContaining(["US", "CA", "JM", "DO", "PR", "VI", "GU", "AS", "MP"]),
    )
    for (const region of regions) expect(region).toMatch(/^[A-Z]{2}$/)
    expect(new Set(regions).size).toBe(regions.length)
  })

  it("returns both regions behind +7", () => {
    expect([...countriesForCallingCode("7")].sort()).toEqual(["KZ", "RU"])
  })

  it("returns the single region of an unshared calling code", () => {
    expect(countriesForCallingCode("91")).toEqual(["IN"])
  })

  it("returns nothing for a calling code libphonenumber does not assign", () => {
    expect(countriesForCallingCode("999")).toEqual([])
  })

  it("memoises per calling code", () => {
    expect(countriesForCallingCode("44")).toBe(countriesForCallingCode("44"))
  })
})
