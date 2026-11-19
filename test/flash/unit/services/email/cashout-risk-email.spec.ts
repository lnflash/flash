// ENG-889: the Cashout Initiated notice carries the risk signals and goes
// only to the configured internal inbox.
const mockSend = jest.fn()

jest.mock("@sendgrid/mail", () => ({
  __esModule: true,
  default: {
    setApiKey: jest.fn(),
    send: (...args: unknown[]) => mockSend(...args),
  },
}))

jest.mock("@config", () => ({
  Cashout: {
    Email: {
      to: "support@flash.test",
      from: "notifications@flash.test",
      subject: "New Cashout",
    },
  },
  FrappeConfig: { url: "https://erp.flash.test" },
  SendGridConfig: { apiKey: "key" },
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import EmailService from "@services/email/EmailService"
import { CashoutBody } from "@services/email/templates/cashout"
import {
  RISK_SIGNALS_UNAVAILABLE_LINE,
  CashoutRiskSignals,
} from "@app/offers/risk-signals/signals"
import { USDAmount } from "@domain/shared"
import type { InitiatedCashout } from "@app/offers/ValidOffer"

const details = {
  payment: {
    userAcct: "wallet-user-123",
    invoice: { paymentHash: "abc123paymenthash" },
  },
  payout: {
    amount: USDAmount.dollars(470.4) as USDAmount,
    serviceFee: USDAmount.dollars(9.6) as USDAmount,
  },
}

const flagged: CashoutRiskSignals = {
  available: true,
  accountAgeDays: 2,
  newAccount: true,
  deposits: {
    available: true,
    deposits: [
      {
        requestId: "dep-1",
        amount: "500.0",
        currency: "usd",
        status: "Completed",
        seenAt: new Date("2026-11-13T14:59:02Z"),
        originatorName: "JOHN <Q> PUBLIC",
        paymentRail: "wire",
      },
    ],
    mismatched: [
      {
        requestId: "dep-1",
        originatorName: "JOHN <Q> PUBLIC",
      },
    ],
    holderNames: ["Taedo Biggs"],
    minutesSinceLastCredit: 0,
  },
}

const makeCashout = (riskSignals?: CashoutRiskSignals) =>
  ({
    cashoutId: "ACC-CSH-1",
    riskSignals,
    offer: {
      account: { username: "taedo", erpParty: "Taedo Biggs", email: "customer@x.test" },
      details,
    },
  }) as unknown as InitiatedCashout

describe("Cashout Initiated notice risk signals", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSend.mockResolvedValue(undefined)
  })

  it("puts the risk lines in the text and HTML bodies", async () => {
    await EmailService.sendCashoutInitiatedEmail(makeCashout(flagged))

    const msg = mockSend.mock.calls[0][0]
    expect(msg.text).toContain("Risk Signals (flag only):")
    expect(msg.text).toContain(
      'WARNING: deposit sender name does not match the account holder. Sender "JOHN <Q> PUBLIC", holder "Taedo Biggs".',
    )
    expect(msg.text).toContain("WARNING: new account, 2 days old (under 30 days).")
    expect(msg.text).toContain("Bridge deposits in the last 72 hours: 1")
    expect(msg.text).toContain("Last deposit credit: under 1 min before this cash-out")

    expect(msg.html).toContain("Risk Signals (flag only)")
    expect(msg.html).toContain("WARNING: new account, 2 days old (under 30 days).")
    // a wire's originator name is outside input: escaped in the HTML
    expect(msg.html).toContain("JOHN &lt;Q&gt; PUBLIC")
    expect(msg.html).not.toContain("JOHN <Q> PUBLIC")
  })

  it("sends only to the configured internal inbox and marks the subject", async () => {
    await EmailService.sendCashoutInitiatedEmail(makeCashout(flagged))

    const msg = mockSend.mock.calls[0][0]
    expect(msg.to).toBe("support@flash.test")
    expect(JSON.stringify(msg)).not.toContain("customer@x.test")
    expect(msg.subject).toBe("[RISK FLAGS] New Cashout")
  })

  it("keeps the plain subject when nothing is flagged", async () => {
    await EmailService.sendCashoutInitiatedEmail(
      makeCashout({
        available: true,
        accountAgeDays: 400,
        newAccount: false,
        deposits: {
          available: true,
          deposits: [],
          mismatched: [],
          holderNames: ["Taedo Biggs"],
        },
      }),
    )

    const msg = mockSend.mock.calls[0][0]
    expect(msg.subject).toBe("New Cashout")
    expect(msg.text).toContain("Account age: 400 days")
  })

  it("says the signals are unavailable when none were gathered", async () => {
    await EmailService.sendCashoutInitiatedEmail(makeCashout(undefined))

    const msg = mockSend.mock.calls[0][0]
    expect(msg.text).toContain(RISK_SIGNALS_UNAVAILABLE_LINE)
    expect(msg.subject).toBe("[RISK FLAGS] New Cashout")
  })

  it("renders the template without a risk section when given no lines", () => {
    const { html, text } = CashoutBody({
      ...details,
      username: "taedo",
      customerName: "Taedo Biggs",
      cashoutId: "ACC-CSH-1",
      erpNextLink: "https://erp.flash.test/app/cashout/ACC-CSH-1",
      formattedDate: "Nov 13, 2026, 10:00 AM",
    } as unknown as Parameters<typeof CashoutBody>[0])

    expect(html).not.toContain("Risk Signals")
    expect(text).not.toContain("Risk Signals")
  })
})
