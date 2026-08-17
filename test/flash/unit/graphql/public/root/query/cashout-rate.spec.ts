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
    // 25% off the Flash fee — a 200-bip config quotes 150 bips.
    const fullFee = Number(Cashout.OfferConfig.fee)
    expect(result.feeBasisPoints).toBe(fullFee * 0.75)
    expect(result.feeBasisPoints).toBeLessThan(fullFee)
    expect(Number.isInteger(result.feeBasisPoints)).toBe(true)
  })

  it("rounds a fractional discount to a whole bip, within the ±1 bip the SDL documents", async () => {
    // feeBasisPoints is an Int, so a discount whose kept-bips product is not an
    // integer CANNOT match the offer exactly: this rounds to a whole bip here,
    // while CashoutManager keeps full precision and rounds once at the end, on
    // money. The SDL description promises "up to 1 bip from rounding" rather
    // than an exact match; this pins that contract so the next reader does not
    // re-tighten the wording. 33.4% off a 200-bip fee -> keptBips 6660 ->
    // round(133.2) = 133 bips quoted, while a $500 cashout is charged
    // 1000¢ * 6660/10000 = 666¢ ($6.66) against a $6.65 preview.
    okRate()
    mockGetFlashFeeDiscountPercent.mockResolvedValue(33.4)

    const result = await resolveQuery()

    const fullFee = Number(Cashout.OfferConfig.fee)
    const exact = (fullFee * (10000 - 3340)) / 10000
    expect(Number.isInteger(exact)).toBe(false)
    expect(result.feeBasisPoints).toBe(Math.round(exact))
    expect(Number.isInteger(result.feeBasisPoints)).toBe(true)
    expect(Math.abs(result.feeBasisPoints - exact)).toBeLessThanOrEqual(1)
  })

  it("is exact for a half-percent-multiple discount at the configured fee", async () => {
    // The other half of the same contract: every discount ops has actually
    // configured (whole and half percents) lands on an integer bip, so preview
    // and offer agree bit-for-bit. If the configured fee ever changes such that
    // this stops holding, this test says so.
    okRate()
    mockGetFlashFeeDiscountPercent.mockResolvedValue(33.5)

    const result = await resolveQuery()

    const fullFee = Number(Cashout.OfferConfig.fee)
    const exact = (fullFee * (10000 - 3350)) / 10000
    expect(Number.isInteger(exact)).toBe(true)
    expect(result.feeBasisPoints).toBe(exact)
  })

  it("quotes a zero fee at a 100% waiver", async () => {
    okRate()
    mockGetFlashFeeDiscountPercent.mockResolvedValue(100)

    expect((await resolveQuery()).feeBasisPoints).toBe(0)
  })

  it("quotes the standard fee when the whitelist is unreadable (fail-open, the other divergence the SDL names)", async () => {
    // getFlashFeeDiscountPercent fails open to 0, so an ERPNext blip degrades
    // the preview to the standard fee instead of breaking the screen. The
    // reverse ordering is the one that generates tickets — a read that works
    // here and fails 60s later when createOffer runs charges the FULL fee
    // against a discounted quote (50 bips on a 25%-off account, not 1), which
    // is why the SDL description names this alongside the rounding tolerance.
    okRate()
    mockGetFlashFeeDiscountPercent.mockResolvedValue(0)

    expect((await resolveQuery()).feeBasisPoints).toBe(Number(Cashout.OfferConfig.fee))
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
