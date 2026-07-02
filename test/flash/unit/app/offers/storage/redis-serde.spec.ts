import { OffersSerde } from "@app/offers/storage/OffersSerde"
import { CashoutDetails } from "@app/offers/types"
import { JMDAmount, USDAmount, USDTAmount } from "@domain/shared"

const usd = (cents: string) => {
  const amount = USDAmount.cents(cents)
  if (amount instanceof Error) throw amount
  return amount
}

const jmd = (cents: string) => {
  const amount = JMDAmount.cents(cents)
  if (amount instanceof Error) throw amount
  return amount
}

const usdt = (cents: string) => {
  const amount = USDTAmount.usdCents(cents)
  if (amount instanceof Error) throw amount
  return amount
}

describe("OffersSerde", () => {
  it("round-trips USDT cashout payment amounts as domain amount instances", () => {
    const details: CashoutDetails = {
      payment: {
        userAcct: "22222222-2222-4222-8222-222222222222" as WalletId,
        flashAcct: "44444444-4444-4444-8444-444444444444" as WalletId,
        invoice: {
          paymentRequest: "lnbc1test" as Bolt11,
          expiresAt: new Date(Date.now() + 60_000),
        } as unknown as LnInvoice,
        amount: usdt("100"),
      },
      payout: {
        bankAccountId: "12345 - First Global",
        amount: jmd("15500"),
        serviceFee: usd("0"),
        exchangeRate: jmd("15500"),
      },
    }

    const parsed = OffersSerde.deserialize(OffersSerde.serialize(details))

    expect(parsed.payment.amount).toBeInstanceOf(USDTAmount)
    const paymentAmount = parsed.payment.amount as USDTAmount
    expect(paymentAmount.isLesserThan(usdt("101"))).toBe(true)
    expect(parsed.payment.invoice.expiresAt).toBeInstanceOf(Date)
    expect(parsed.payout.amount).toBeInstanceOf(JMDAmount)
    expect(parsed.payout.serviceFee).toBeInstanceOf(USDAmount)
  })

  it("throws instead of hydrating invalid amount tuples into Error objects", () => {
    const invalidSerializedOffer = JSON.stringify({
      payment: {
        userAcct: "22222222-2222-4222-8222-222222222222",
        flashAcct: "44444444-4444-4444-8444-444444444444",
        invoice: {
          paymentRequest: "lnbc1test",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        amount: ["not-a-number", "USDT"],
      },
      payout: {
        bankAccountId: "12345 - First Global",
        amount: ["15500", "JMD"],
        serviceFee: ["0", "USD"],
        exchangeRate: ["15500", "JMD"],
      },
    })

    expect(() => OffersSerde.deserialize(invalidSerializedOffer)).toThrow()
  })
})
