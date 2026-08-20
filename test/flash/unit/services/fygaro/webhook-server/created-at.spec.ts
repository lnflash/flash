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
    // These are the values that make 1970 come BACK. Each one coerces to a
    // non-positive number, and a 0 read as epoch seconds is 1970-01-01 —
    // indistinguishable, to the operator reading first_seen_at, from a real
    // timestamp. -1 is just as common a sentinel, and it used to produce two
    // DIFFERENT fictions depending on JSON type: the number gave
    // 1969-12-31T23:59:59Z, the string fell through to the date branch and gave
    // 2001-01-01. Fygaro is a card processor that did not exist before 1970.
    for (const value of [0, "0", -1, "-1", " ", "  \t "]) {
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

  it("reads a fractional epoch the same whether it arrives quoted or bare", () => {
    // A provider that stringifies a float clock sends "1786940395.75". The bare
    // number was always read correctly; the quoted form used to fail the
    // digits-only gate and blank the column — the same value producing two
    // different answers depending on how the JSON happened to be serialised.
    expect(fygaroCreatedAtToIso(1786940395.75)).toBe("2026-08-17T04:19:55.750Z")
    expect(fygaroCreatedAtToIso("1786940395.75")).toBe("2026-08-17T04:19:55.750Z")
    expect(fygaroCreatedAtToIso("1786940395.5")).toBe("2026-08-17T04:19:55.500Z")
    expect(fygaroCreatedAtToIso("1786940395.000")).toBe("2026-08-17T04:19:55.000Z")
    expect(fygaroCreatedAtToIso("+1786940395")).toBe("2026-08-17T04:19:55.000Z")
  })

  it("does not read a small BARE number as epoch seconds either", () => {
    // The mirror of the test above, and the asymmetry it left open: the 9-digit
    // gate only guards strings, so `"2026"` was read as a year while the NUMBER
    // 2026 went down the epoch path to 1970-01-01T00:33:46Z. The same value
    // giving two answers depending on how the JSON was serialised is this bug
    // wearing a different payload. 1786940 — a truncated timestamp — is the one
    // that matters most: it returns 1970-01-21, byte-identical to the rows this
    // PR exists to stop producing.
    for (const value of [1, 2026, 1786940, 99999999]) {
      expect(fygaroCreatedAtToIso(value)).toBeUndefined()
    }
    // The floor sits below any real timestamp, so nothing real is refused.
    expect(fygaroCreatedAtToIso(1e8)).toBe("1973-03-03T09:46:40.000Z")
  })

  it("refuses non-ISO date strings rather than parsing them host-locally", () => {
    // `new Date`'s legacy parser is implementation-defined and reads zoneless
    // input as HOST-LOCAL, so these slide with the container's offset:
    // "Mon, 17 Aug 2026 15:00:00" gave 15:00Z under TZ=UTC and the NEXT calendar
    // day under the site's America/Adak. Refusing the format is honest; parsing
    // it while the docblock promises UTC is not.
    for (const value of [
      "Mon, 17 Aug 2026 15:00:00",
      "Aug 17 2026",
      "2026/08/17",
      "08/17/2026",
    ]) {
      expect(fygaroCreatedAtToIso(value)).toBeUndefined()
    }
  })

  it("reads a zoneless datetime as UTC, not as whatever the host clock is set to", () => {
    // "2026-08-17 15:00:00" is the shape Frappe emits and the likeliest form if
    // Fygaro ever moves off epoch. `new Date` reads it as HOST-LOCAL, so the
    // answer used to slide with the container's offset: 20:00Z under
    // America/Jamaica, and under the site's configured America/Adak it landed
    // on 2026-08-18 — the wrong calendar day. This assertion holds under every
    // TZ; run the suite with TZ=America/Adak to see it bite.
    expect(fygaroCreatedAtToIso("2026-08-17 15:00:00")).toBe("2026-08-17T15:00:00.000Z")
    expect(fygaroCreatedAtToIso("2026-08-17T15:00:00")).toBe("2026-08-17T15:00:00.000Z")
    expect(fygaroCreatedAtToIso("2026-08-17 15:00")).toBe("2026-08-17T15:00:00.000Z")
  })
})
