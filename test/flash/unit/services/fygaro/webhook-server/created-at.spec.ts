import { fygaroCreatedAtToIso } from "@services/fygaro/webhook-server/created-at"

describe("fygaroCreatedAtToIso", () => {
  it("reads Fygaro's epoch SECONDS as seconds, not milliseconds", () => {
    // The bug, exactly. 1786940395 is what Fygaro sends; handing it straight to
    // `new Date` reads it as milliseconds and lands on 1970-01-21, which is what
    // every Fygaro audit row has carried in first_seen_at.
    expect(fygaroCreatedAtToIso(1786940395)).toBe("2026-08-17T04:19:55.000Z")
    expect(new Date(1786940395).getUTCFullYear()).toBe(1970)
  })

  it("accepts the same value as a numeric string", () => {
    // JSON numbers are what we have observed, but a provider that quotes them
    // must not silently become a 1970 row again.
    expect(fygaroCreatedAtToIso("1786940395")).toBe("2026-08-17T04:19:55.000Z")
  })

  it("reads milliseconds correctly too, so a provider switch is not the mirror bug", () => {
    // The same instant, three orders larger. Treating this as seconds would put
    // the row ~56,000 years out — this bug inverted.
    expect(fygaroCreatedAtToIso(1786940395000)).toBe("2026-08-17T04:19:55.000Z")
  })

  it("passes an ISO string through", () => {
    expect(fygaroCreatedAtToIso("2026-08-17T04:19:55.000Z")).toBe(
      "2026-08-17T04:19:55.000Z",
    )
  })

  it("returns undefined rather than a fiction when there is nothing usable", () => {
    // An empty column is honest; a parsed-from-garbage timestamp is not, and it
    // is the field an operator reads to answer "when did this payment arrive".
    for (const value of [undefined, null, "", "not a date"]) {
      expect(fygaroCreatedAtToIso(value)).toBeUndefined()
    }
  })

  it("never returns a date in the 1970s for a present-day payment", () => {
    // The regression net: whatever shape a real captured payload carries, the
    // answer must land in this century.
    for (const value of [1786940395, "1786940395", 1786940395000]) {
      const iso = fygaroCreatedAtToIso(value)
      expect(new Date(iso as string).getUTCFullYear()).toBeGreaterThan(2000)
    }
  })
})
