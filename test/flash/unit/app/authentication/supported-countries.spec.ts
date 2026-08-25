import { getSupportedCountries } from "@app/authentication/get-supported-countries"

// Runs against the REAL config on purpose: this is the only place the two
// country lists meet, and the failure it guards against is invisible in any
// spec that mocks @config.
describe("getSupportedCountries", () => {
  const supported = getSupportedCountries()
  const ids = supported.map((country) => String(country.id))

  // The server-side gate carves out existing accounts in a blocked country so
  // they keep receiving login codes. That carve-out only ever runs if the app
  // lets the user pick the country in the first place: `globals
  // .supportedCountries` IS the picker. Seeding the picker's unsupported lists
  // with the block list would make every UZ/TR account unable to select its own
  // dialling code, and the carve-out unreachable from the app.
  it("still offers the blocked countries, so their existing accounts can reach the carve-out", () => {
    expect(ids).toContain("UZ")
    expect(ids).toContain("TR")
    expect(ids).toContain("RU")
  })

  it("offers a supported market on both channels", () => {
    const jamaica = supported.find((country) => String(country.id) === "JM")

    expect(jamaica?.supportedAuthChannels).toEqual(["sms", "whatsapp"])
  })
})
