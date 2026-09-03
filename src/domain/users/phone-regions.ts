import { getCountries, getCountryCallingCode } from "libphonenumber-js"

// libphonenumber can parse a number without being able to name its region:
// 340 of the 800 assigned NANP area codes are absent from the pinned metadata,
// including in-service US overlays such as +1 738, +1 924, +1 983 and +1 472.
// Every gate that keys on a phone's country therefore needs a second answer
// for "parsed, but no region": the set of every region the calling code could
// denote. How a gate combines those candidates is its own decision — the auth
// destination check fails closed on a block list (any candidate blocked ⇒
// blocked); the Bridge KYC gate passes an allowlist if any candidate is
// allowed — but the candidate set itself must be the same one everywhere.
const regionsByCallingCode: Map<string, CountryCode[]> = new Map()

/** Every region libphonenumber assigns to a calling code (e.g. "1" ⇒ the 25 NANP regions). */
export const countriesForCallingCode = (callingCode: string): CountryCode[] => {
  const cached = regionsByCallingCode.get(callingCode)
  if (cached !== undefined) return cached

  const regions = getCountries().filter(
    (country) => getCountryCallingCode(country) === callingCode,
  ) as CountryCode[]
  regionsByCallingCode.set(callingCode, regions)
  return regions
}
