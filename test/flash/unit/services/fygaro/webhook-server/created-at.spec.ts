import { fygaroCreatedAtToIso } from "@services/fygaro/webhook-server/created-at"

describe("fygaroCreatedAtToIso", () => {
  it("reads Fygaro's epoch SECONDS as seconds, not milliseconds", () => {
    // The bug, exactly. 1786940395 is what Fygaro sends; handing it straight to
    // `new Date` reads it as milliseconds and lands on 1970-01-21 — which is
    // what every Fygaro audit row has carried in first_seen_at.
    expect(fygaroCreatedAtToIso(1786940395)).toBe("2026-08-17T04:19:55.000Z")
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

  it("treats an unset timestamp as absent rather than as the epoch instant", () => {
    // These are the values that make 1970 come BACK. Each one coerces to 0, and
    // a 0 read as epoch seconds is 1970-01-01 — indistinguishable, to the
    // operator reading first_seen_at, from a real timestamp. Empty is honest.
    for (const value of [0, "0", " ", "  \t "]) {
      expect(fygaroCreatedAtToIso(value)).toBeUndefined()
    }
  })

  it("does not read a bare-numeric date string as epoch seconds", () => {
    // A provider switching to date strings is the likeliest future change, and
    // "2026" coerces to the number 2026. Read as epoch seconds that is
    // 1970-01-01T00:33:46Z — this same bug in a different payload. It must be
    // parsed as a date.
    expect(fygaroCreatedAtToIso("2026")).toBe("2026-01-01T00:00:00.000Z")
    expect(fygaroCreatedAtToIso("2026-08-17")).toBe("2026-08-17T00:00:00.000Z")
  })

  it("still reads a quoted epoch timestamp as epoch, not as a date string", () => {
    // The other side of the gate above: 9+ digits is a timestamp, not a year.
    expect(fygaroCreatedAtToIso(" 1786940395 ")).toBe("2026-08-17T04:19:55.000Z")
  })
})
