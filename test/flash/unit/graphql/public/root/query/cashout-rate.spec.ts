const mockGetCashoutExchangeRate = jest.fn()
jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: {
    getCashoutExchangeRate: (...a: unknown[]) => mockGetCashoutExchangeRate(...a),
  },
}))

const mockGetFlashFeeDiscountPercent = jest.fn()
jest.mock("@services/frappe/fee-discounts", () => ({
  getFlashFeeDiscountPercent: (...a: unknown[]) => mockGetFlashFeeDiscountPercent(...a),
}))

import { Cashout } from "@config"
import { JMDAmount } from "@domain/shared"
import CashoutRateQuery from "@graphql/public/root/query/cashout-rate"
import { ExchangeRateQueryError } from "@services/frappe/errors"

type CashoutRateResult = {
  exchangeRate: JMDAmount
  feeBasisPoints: number
}

const USERNAME = "civilizedbarbarian"

const resolveQuery = async (
  { username }: { username?: string } = { username: USERNAME },
): Promise<CashoutRateResult> => {
  const query = CashoutRateQuery as unknown as {
    resolve: (
      source: null,
      args: Record<string, never>,
      context: unknown,
      info: never,
    ) => Promise<CashoutRateResult>
  }
  // cashoutRate is an authed atAccountLevel query, so the account is always in
  // resolver context — that is what makes a per-account fee quote possible.
  return query.resolve(null, {}, { domainAccount: { username } }, undefined as never)
}

const okRate = () => {
  const rate = JMDAmount.dollars(152.7)
  if (rate instanceof Error) throw rate
  mockGetCashoutExchangeRate.mockResolvedValue(rate)
  return rate
}

beforeEach(() => {
  mockGetCashoutExchangeRate.mockReset()
  mockGetFlashFeeDiscountPercent.mockReset()
  // Nobody discounted by default.
  mockGetFlashFeeDiscountPercent.mockResolvedValue(0)
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

  it("quotes the DISCOUNTED fee for a whitelisted account so the preview matches the offer", async () => {
    // CashoutManager.createOffer discounts the same user's fee when it builds
    // the offer; quoting the undiscounted config fee here would make the
    // entry-screen preview disagree with the offer the user then accepts —
    // exactly the mismatch this query exists to prevent.
    okRate()
    mockGetFlashFeeDiscountPercent.mockResolvedValue(25)

    const result = await resolveQuery()

    expect(mockGetFlashFeeDiscountPercent).toHaveBeenCalledWith({
      username: USERNAME,
      flow: "cashout",
    })
    // 25% off the Flash fee — a 100-bip config quotes 75 bips.
    const fullFee = Number(Cashout.OfferConfig.fee)
    expect(result.feeBasisPoints).toBe(fullFee * 0.75)
    expect(result.feeBasisPoints).toBeLessThan(fullFee)
    expect(Number.isInteger(result.feeBasisPoints)).toBe(true)
  })

  it("quotes a zero fee at a 100% waiver", async () => {
    okRate()
    mockGetFlashFeeDiscountPercent.mockResolvedValue(100)

    expect((await resolveQuery()).feeBasisPoints).toBe(0)
  })

  it("quotes the standard fee for an account with no username", async () => {
    okRate()

    const result = await resolveQuery({})

    expect(mockGetFlashFeeDiscountPercent).toHaveBeenCalledWith({
      username: undefined,
      flow: "cashout",
    })
    expect(result.feeBasisPoints).toBe(Number(Cashout.OfferConfig.fee))
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
