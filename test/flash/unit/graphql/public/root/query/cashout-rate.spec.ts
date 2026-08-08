const mockGetCashoutExchangeRate = jest.fn()
jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: {
    getCashoutExchangeRate: (...a: unknown[]) => mockGetCashoutExchangeRate(...a),
  },
}))

import { Cashout } from "@config"
import { JMDAmount } from "@domain/shared"
import CashoutRateQuery from "@graphql/public/root/query/cashout-rate"
import { ExchangeRateQueryError } from "@services/frappe/errors"

type CashoutRateResult = {
  exchangeRate: JMDAmount
  feeBasisPoints: number
}

const resolveQuery = async (): Promise<CashoutRateResult> => {
  const query = CashoutRateQuery as unknown as {
    resolve: (
      source: null,
      args: Record<string, never>,
      context: unknown,
      info: never,
    ) => Promise<CashoutRateResult>
  }
  return query.resolve(null, {}, {}, undefined as never)
}

beforeEach(() => {
  mockGetCashoutExchangeRate.mockReset()
})

describe("cashoutRate query", () => {
  it("returns the live ERPNext settlement rate and the configured fee", async () => {
    const rate = JMDAmount.dollars(152.7)
    if (rate instanceof Error) throw rate
    mockGetCashoutExchangeRate.mockResolvedValue(rate)

    const result = await resolveQuery()

    expect(result.exchangeRate).toBe(rate)
    // Serialized by JMDCentsScalar as cents: 152.70 JMD -> 15270
    expect(Number(result.exchangeRate.asCents())).toBe(15270)
    expect(result.feeBasisPoints).toBe(Number(Cashout.OfferConfig.fee))
    expect(Number.isInteger(result.feeBasisPoints)).toBe(true)
  })

  it("fails closed when ERPNext has no rate — never quotes a guessed rate", async () => {
    mockGetCashoutExchangeRate.mockResolvedValue(
      new ExchangeRateQueryError("No USD->JMD for_buying rate found in ERPNext"),
    )

    // The resolver throws the mapped IError object (same pattern as
    // myReferrals) — a plain object, so assert its shape, not instanceof.
    await expect(resolveQuery()).rejects.toMatchObject({
      message:
        "Cashout is temporarily unavailable while we refresh the exchange rate. Please try again shortly.",
      code: expect.any(String),
    })
    expect(mockGetCashoutExchangeRate).toHaveBeenCalledTimes(1)
  })
})
