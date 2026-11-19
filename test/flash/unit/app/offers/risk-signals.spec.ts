const mockListRecentBridgeDepositRows = jest.fn()
const mockGetCustomer = jest.fn()

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: {
    listRecentBridgeDepositRows: (...args: unknown[]) =>
      mockListRecentBridgeDepositRows(...args),
  },
}))

jest.mock("@services/bridge/client", () => ({
  __esModule: true,
  default: { getCustomer: (...args: unknown[]) => mockGetCustomer(...args) },
}))

import {
  DEPOSIT_SIGNALS_UNAVAILABLE_LINE,
  RISK_REMARKS_HEADER,
  RISK_SIGNALS_UNAVAILABLE_LINE,
  accountAgeDays,
  buildDepositSignals,
  formatRiskLines,
  formatRiskRemarks,
  getCashoutRiskSignals,
  hasRiskWarning,
  inDepositWindow,
  isNameMismatch,
  isNewAccount,
  namesMatch,
  parseDepositSource,
  toRecentBridgeDeposit,
  uniqueNames,
} from "@app/offers/risk-signals"
import { BridgeDepositHistoryQueryError } from "@services/frappe/errors"
import { baseLogger } from "@services/logger"

const NOW = new Date("2026-11-13T15:00:00Z")
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60 * 1000)
const hoursAgo = (h: number) => minutesAgo(h * 60)
const daysAgo = (d: number) => hoursAgo(d * 24)

// last_seen_at as toFrappeDatetime writes it: naive UTC.
const frappeUtc = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ")

const bridgeRow = ({
  seenAt,
  status = "Completed",
  originatorName,
  amount = "500.0",
}: {
  seenAt: Date
  status?: string
  originatorName?: string
  amount?: string
}) => ({
  request_id: "dep-1",
  status,
  amount,
  currency: "usd",
  last_seen_at: frappeUtc(seenAt),
  raw_payload_json: JSON.stringify({
    event_id: "wh_1",
    event_object: {
      id: "act-1",
      type: "funds_received",
      source: {
        payment_rail: "wire",
        bank_name: "Example Bank",
        ...(originatorName === undefined ? {} : { originator_name: originatorName }),
      },
    },
  }),
})

describe("cash-out risk signals: name matching", () => {
  it("matches the same name across case, whitespace and punctuation", () => {
    expect(namesMatch("Taedo Biggs", "  TAEDO   biggs ")).toBe(true)
    expect(namesMatch("Biggs, Taedo", "Taedo Biggs")).toBe(true)
    expect(namesMatch("Taédo Bïggs", "Taedo Biggs")).toBe(true)
  })

  it("treats a token subset as a match", () => {
    expect(namesMatch("TAEDO D BIGGS", "Taedo Biggs")).toBe(true)
    expect(namesMatch("Taedo Biggs", "TAEDO DWAYNE BIGGS")).toBe(true)
  })

  it("flags a different name as a mismatch", () => {
    expect(namesMatch("JOHN Q PUBLIC", "Taedo Biggs")).toBe(false)
    expect(namesMatch("ACME TRADING LLC", "Taedo Biggs")).toBe(false)
  })

  it("does not accept a shared surname alone", () => {
    expect(namesMatch("BIGGS", "Taedo Biggs")).toBe(false)
    expect(namesMatch("MARY BIGGS", "Taedo Biggs")).toBe(false)
  })

  it("matches one-part names only exactly", () => {
    expect(namesMatch("Madonna", "MADONNA")).toBe(true)
    expect(namesMatch("Madonna", "Cher")).toBe(false)
  })

  it("never matches an empty or missing name", () => {
    expect(namesMatch("", "Taedo Biggs")).toBe(false)
    expect(namesMatch(undefined, "Taedo Biggs")).toBe(false)
    expect(namesMatch("Taedo Biggs", null)).toBe(false)
    expect(namesMatch(" ,. ", " ")).toBe(false)
  })

  it("reports a mismatch only when both names are known", () => {
    const deposit = { requestId: "d", originatorName: "JOHN Q PUBLIC" }
    expect(isNameMismatch(deposit, ["Taedo Biggs"])).toBe(true)
    // a second holder name (Bridge KYC) that matches clears it
    expect(isNameMismatch(deposit, ["Taedo Biggs", "John Public"])).toBe(false)
    // nothing to compare against: not a mismatch
    expect(isNameMismatch(deposit, [])).toBe(false)
    expect(isNameMismatch(deposit, [""])).toBe(false)
    // no originator recorded: not a mismatch
    expect(isNameMismatch({ requestId: "d" }, ["Taedo Biggs"])).toBe(false)
    expect(isNameMismatch({ requestId: "d", originatorName: " " }, ["Taedo Biggs"])).toBe(
      false,
    )
  })
})

describe("cash-out risk signals: account age", () => {
  it("flags accounts under 30 days and not at 30 days", () => {
    expect(accountAgeDays(daysAgo(2), NOW)).toBe(2)
    expect(isNewAccount(accountAgeDays(daysAgo(2), NOW))).toBe(true)
    expect(isNewAccount(accountAgeDays(new Date(daysAgo(30).getTime() + 1), NOW))).toBe(
      true,
    )
    expect(accountAgeDays(daysAgo(30), NOW)).toBe(30)
    expect(isNewAccount(accountAgeDays(daysAgo(30), NOW))).toBe(false)
    expect(isNewAccount(accountAgeDays(daysAgo(400), NOW))).toBe(false)
  })

  it("does not flag an unknown age", () => {
    expect(accountAgeDays(undefined, NOW)).toBeUndefined()
    expect(accountAgeDays(new Date("not a date"), NOW)).toBeUndefined()
    expect(isNewAccount(undefined)).toBe(false)
  })
})

describe("cash-out risk signals: 72 hour deposit window", () => {
  it("includes the boundary and excludes anything older", () => {
    expect(inDepositWindow(hoursAgo(72), NOW)).toBe(true)
    expect(inDepositWindow(new Date(hoursAgo(72).getTime() - 1), NOW)).toBe(false)
    expect(inDepositWindow(minutesAgo(1), NOW)).toBe(true)
    expect(inDepositWindow(undefined, NOW)).toBe(false)
  })

  it("keeps only deposits in the window, newest first, and times the last credit", () => {
    const signals = buildDepositSignals({
      deposits: [
        toRecentBridgeDeposit(bridgeRow({ seenAt: hoursAgo(80), originatorName: "OLD" })),
        toRecentBridgeDeposit(
          bridgeRow({ seenAt: minutesAgo(30), originatorName: "TAEDO D BIGGS" }),
        ),
        toRecentBridgeDeposit(
          bridgeRow({
            seenAt: minutesAgo(5),
            status: "Fiat Received",
            originatorName: "JOHN Q PUBLIC",
          }),
        ),
      ],
      holderNames: ["Taedo Biggs"],
      now: NOW,
    })
    if (!signals.available) throw new Error("expected available")
    expect(signals.deposits.map((d) => d.originatorName)).toEqual([
      "JOHN Q PUBLIC",
      "TAEDO D BIGGS",
    ])
    expect(signals.mismatched.map((d) => d.originatorName)).toEqual(["JOHN Q PUBLIC"])
    // the newest Completed row, not the newest row
    expect(signals.minutesSinceLastCredit).toBe(30)
  })
})

describe("cash-out risk signals: Bridge payload parsing", () => {
  it("reads the originator, bank and rail from the stored webhook payload", () => {
    const row = bridgeRow({ seenAt: minutesAgo(1), originatorName: "JOHN Q PUBLIC" })
    expect(toRecentBridgeDeposit(row)).toEqual({
      requestId: "dep-1",
      status: "Completed",
      amount: "500.0",
      currency: "usd",
      seenAt: new Date(frappeUtc(minutesAgo(1)).replace(" ", "T") + "Z"),
      originatorName: "JOHN Q PUBLIC",
      bankName: "Example Bank",
      paymentRail: "wire",
    })
  })

  it("yields no source fields from bad or missing JSON", () => {
    expect(parseDepositSource("{not json")).toEqual({})
    expect(parseDepositSource(null)).toEqual({})
    expect(parseDepositSource(JSON.stringify({ event_object: {} }))).toEqual({})
    expect(
      toRecentBridgeDeposit({ request_id: null, amount: null, raw_payload_json: null }),
    ).toEqual({ requestId: "unknown" })
  })
})

describe("cash-out risk signals: formatting", () => {
  // The 2026-11-13 cash-out: a 2-day-old account, a $500 wire from someone
  // else, cashed out 58 seconds after the credit.
  const incident = {
    available: true as const,
    accountAgeDays: 2,
    newAccount: true,
    deposits: buildDepositSignals({
      deposits: [
        toRecentBridgeDeposit(
          bridgeRow({
            seenAt: new Date(NOW.getTime() - 58_000),
            originatorName: "JOHN Q PUBLIC",
          }),
        ),
      ],
      holderNames: ["Taedo Biggs"],
      now: NOW,
    }),
  }

  it("puts the warnings first and lists every signal", () => {
    const lines = formatRiskLines(incident)
    expect(lines[0]).toBe(
      'WARNING: deposit sender name does not match the account holder. Sender "JOHN Q PUBLIC", holder "Taedo Biggs".',
    )
    expect(lines[1]).toBe("WARNING: new account, 2 days old (under 30 days).")
    expect(lines).toContain("Account age: 2 days")
    expect(lines).toContain("Bridge deposits in the last 72 hours: 1")
    expect(lines).toContain(
      '- 500.0 USD, Completed, 2026-11-13 14:59 UTC, sender "JOHN Q PUBLIC", wire, Example Bank',
    )
    expect(lines).toContain("Last deposit credit: under 1 min before this cash-out")
    expect(hasRiskWarning(incident)).toBe(true)
  })

  it("prints a quiet account without warnings", () => {
    const quiet = {
      available: true as const,
      accountAgeDays: 400,
      newAccount: false,
      deposits: buildDepositSignals({
        deposits: [],
        holderNames: ["Taedo Biggs"],
        now: NOW,
      }),
    }
    expect(formatRiskLines(quiet)).toEqual([
      "Account age: 400 days",
      "Bridge deposits in the last 72 hours: 0",
    ])
    expect(hasRiskWarning(quiet)).toBe(false)
  })

  it("says so when a sender cannot be compared", () => {
    const lines = formatRiskLines({
      available: true,
      accountAgeDays: 400,
      newAccount: false,
      deposits: buildDepositSignals({
        deposits: [toRecentBridgeDeposit(bridgeRow({ seenAt: minutesAgo(90) }))],
        holderNames: [],
        now: NOW,
      }),
    })
    expect(lines).toContain(
      "- 500.0 USD, Completed, 2026-11-13 13:30 UTC, sender not recorded, wire, Example Bank",
    )
    expect(lines).toContain("Account holder name unknown, sender names not compared.")
    expect(lines).toContain("Last deposit credit: 90 min before this cash-out")
  })

  it("prints the unavailable lines", () => {
    expect(formatRiskLines({ available: false })).toEqual([RISK_SIGNALS_UNAVAILABLE_LINE])
    const partial = {
      available: true as const,
      accountAgeDays: 400,
      newAccount: false,
      deposits: { available: false as const },
    }
    expect(formatRiskLines(partial)).toEqual([
      "Account age: 400 days",
      DEPOSIT_SIGNALS_UNAVAILABLE_LINE,
    ])
    expect(hasRiskWarning(partial)).toBe(true)
  })

  it("builds the ERPNext remarks from the same lines", () => {
    const remarks = formatRiskRemarks(incident)
    expect(remarks.split("\n")).toEqual([
      RISK_REMARKS_HEADER,
      ...formatRiskLines(incident),
    ])
    expect(remarks).toContain("WARNING: deposit sender name does not match")
    expect(remarks).toContain("Account age: 2 days")
  })

  it("keeps ops text plain", () => {
    const all = [
      ...formatRiskLines(incident),
      ...formatRiskLines({ available: false }),
      DEPOSIT_SIGNALS_UNAVAILABLE_LINE,
      RISK_REMARKS_HEADER,
    ].join("\n")
    expect(all).not.toMatch(/\u2014|\u2013/)
    expect(all.toLowerCase()).not.toContain("crypto")
  })
})

describe("getCashoutRiskSignals", () => {
  const account = {
    id: "acct-1" as AccountId,
    createdAt: daysAgo(2),
    erpParty: "Taedo Biggs",
    bridgeCustomerId: "cust-1" as BridgeCustomerId,
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("reads deposits by Bridge customer over the last 72 hours", async () => {
    mockListRecentBridgeDepositRows.mockResolvedValue([
      bridgeRow({ seenAt: minutesAgo(1), originatorName: "TAEDO D BIGGS" }),
    ])

    const signals = await getCashoutRiskSignals({ account, now: NOW })

    expect(mockListRecentBridgeDepositRows).toHaveBeenCalledWith({
      bridgeCustomerId: "cust-1",
      since: hoursAgo(72),
    })
    expect(mockGetCustomer).not.toHaveBeenCalled()
    expect(signals).toMatchObject({
      available: true,
      accountAgeDays: 2,
      newAccount: true,
      deposits: { available: true, mismatched: [], minutesSinceLastCredit: 1 },
    })
  })

  it("checks the Bridge KYC name before calling a sender a mismatch", async () => {
    mockListRecentBridgeDepositRows.mockResolvedValue([
      bridgeRow({ seenAt: minutesAgo(1), originatorName: "TAEDO D BIGGS" }),
    ])
    mockGetCustomer.mockResolvedValue({
      type: "individual",
      first_name: "Taedo",
      last_name: "Biggs",
    })

    const signals = await getCashoutRiskSignals({
      account: { ...account, erpParty: "CUST-00042" },
      now: NOW,
    })

    expect(mockGetCustomer).toHaveBeenCalledWith("cust-1")
    expect(signals).toMatchObject({
      available: true,
      deposits: {
        available: true,
        mismatched: [],
        holderNames: ["CUST-00042", "Taedo Biggs"],
      },
    })
  })

  it("still flags the mismatch when the Bridge KYC lookup fails", async () => {
    mockListRecentBridgeDepositRows.mockResolvedValue([
      bridgeRow({ seenAt: minutesAgo(1), originatorName: "JOHN Q PUBLIC" }),
    ])
    mockGetCustomer.mockRejectedValue(new Error("bridge down"))

    const signals = await getCashoutRiskSignals({ account, now: NOW })

    expect(signals).toMatchObject({
      available: true,
      deposits: { available: true, holderNames: ["Taedo Biggs"] },
    })
    if (!signals.available || !signals.deposits.available) throw new Error("expected")
    expect(signals.deposits.mismatched).toHaveLength(1)
  })

  it("skips the deposit lookup for an account with no Bridge customer", async () => {
    const signals = await getCashoutRiskSignals({
      account: { ...account, bridgeCustomerId: undefined },
      now: NOW,
    })
    expect(mockListRecentBridgeDepositRows).not.toHaveBeenCalled()
    expect(formatRiskLines(signals)).toContain("Bridge deposits in the last 72 hours: 0")
  })

  it("marks deposits unavailable when ERPNext returns an error", async () => {
    mockListRecentBridgeDepositRows.mockResolvedValue(
      new BridgeDepositHistoryQueryError("erp down"),
    )

    const signals = await getCashoutRiskSignals({ account, now: NOW })

    expect(signals).toMatchObject({
      available: true,
      accountAgeDays: 2,
      deposits: { available: false },
    })
    expect(formatRiskLines(signals)).toContain(DEPOSIT_SIGNALS_UNAVAILABLE_LINE)
    expect(baseLogger.warn).toHaveBeenCalled()
  })

  it("resolves unavailable, never rejects, when a lookup throws", async () => {
    mockListRecentBridgeDepositRows.mockRejectedValue(new Error("socket hang up"))

    const signals = await getCashoutRiskSignals({ account, now: NOW })

    expect(signals).toEqual({ available: false })
    expect(formatRiskLines(signals)).toEqual([RISK_SIGNALS_UNAVAILABLE_LINE])
    expect(baseLogger.warn).toHaveBeenCalled()
  })

  it("resolves unavailable when the lookup is too slow", async () => {
    mockListRecentBridgeDepositRows.mockReturnValue(new Promise(() => undefined))

    const signals = await getCashoutRiskSignals({ account, now: NOW, timeoutMs: 10 })

    expect(signals).toEqual({ available: false })
  })

  it("resolves unavailable with no account", async () => {
    expect(await getCashoutRiskSignals({ account: undefined, now: NOW })).toEqual({
      available: false,
    })
  })
})

describe("cash-out risk signals: holder names", () => {
  it("names each holder once", () => {
    expect(
      uniqueNames(["Taedo Biggs", "TAEDO  BIGGS", "", " ", "Taedo D Biggs"]),
    ).toEqual(["Taedo Biggs", "Taedo D Biggs"])
  })
})
