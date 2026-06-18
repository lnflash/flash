import { CashoutBody } from "@services/email/templates/cashout"
import { USDAmount } from "@domain/shared"

// Focused template test for the cashout-initiated notification email (ENG-409).
// Verifies the ops-context enrichment: ERPNext customer name, a clickable
// ERPNext Cashout link, and that an absent username no longer renders as
// "undefined".
describe("CashoutBody", () => {
  const baseArgs = {
    payment: {
      userAcct: "wallet-user-123",
      invoice: { paymentHash: "abc123paymenthash" },
    },
    payout: {
      amount: USDAmount.dollars(100) as USDAmount,
      serviceFee: USDAmount.dollars(2.5) as USDAmount,
    },
    username: "johndoe",
    customerName: "John Smith",
    cashoutId: "CASH-0001",
    erpNextLink: "https://erp.flash.test/app/cashout/CASH-0001",
    formattedDate: "Jun 18, 2026, 10:00 AM",
  } as unknown as Parameters<typeof CashoutBody>[0]

  it("renders the ERPNext customer name, cashout id, and a clickable Cashout link", () => {
    const { html, text } = CashoutBody(baseArgs)

    expect(html).toContain("John Smith")
    expect(html).toContain("CASH-0001")
    expect(html).toContain('href="https://erp.flash.test/app/cashout/CASH-0001"')

    expect(text).toContain("Customer: John Smith")
    expect(text).toContain("ERPNext: https://erp.flash.test/app/cashout/CASH-0001")
    expect(text).toContain("Cashout ID: CASH-0001")
  })

  it("does not render 'undefined' when the username is absent (ENG-409)", () => {
    const { html, text } = CashoutBody({ ...baseArgs, username: "" })

    expect(html).not.toContain("undefined")
    expect(text).not.toContain("undefined")
    // Customer name (from erpParty) still shown even with no username.
    expect(html).toContain("John Smith")
  })
})
