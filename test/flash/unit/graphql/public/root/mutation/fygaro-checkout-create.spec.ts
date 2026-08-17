// jest.mock calls are hoisted before imports

jest.mock("@app/fygaro/authorize-topup", () => ({
  authorizeFygaroTopup: (...args: unknown[]) => mockAuthorizeFygaroTopup(...args),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const mockAuthorizeFygaroTopup = jest.fn()

import { AccountLevel } from "@domain/accounts"
import { InputValidationError } from "@graphql/error"
import FygaroCheckoutCreateMutation from "@graphql/public/root/mutation/fygaro-checkout-create"

const ACCOUNT_ID = "account-001" as AccountId
const EXPIRES_AT = new Date("2026-08-16T12:15:00Z")
const CHECKOUT = {
  url: "https://fygaro.com/en/pb/ABC123?jwt=header.payload.signature",
  expiresAt: EXPIRES_AT,
  customReference: "jaceth2009|intent-1",
}

type CheckoutCreateResult = {
  errors: Array<{ code?: string; message?: string }>
  checkout?: { url?: string; expiresAt?: Date; amount?: number }
  remainingAllowance?: number
}

const ctx = (overrides: Record<string, unknown> = {}) =>
  ({
    domainAccount: {
      id: ACCOUNT_ID,
      level: AccountLevel.One,
      username: "jaceth2009",
      ...overrides,
    },
  }) as unknown as GraphQLPublicContextAuth

const resolve = async (
  amount: unknown,
  context: GraphQLPublicContextAuth = ctx(),
): Promise<CheckoutCreateResult> => {
  const mutation = FygaroCheckoutCreateMutation as unknown as {
    resolve: (
      source: null,
      args: { input: { amount: unknown } },
      context: GraphQLPublicContextAuth,
      info: never,
    ) => Promise<CheckoutCreateResult>
  }
  return mutation.resolve(null, { input: { amount } }, context, {} as never)
}

beforeEach(() => {
  jest.clearAllMocks()
  mockAuthorizeFygaroTopup.mockResolvedValue({
    authorized: true,
    checkout: CHECKOUT,
    remainingAllowanceCents: 2000,
  })
})

describe("fygaroCheckoutCreate resolver", () => {
  it("returns the signed checkout and what is left of today's allowance", async () => {
    const result = await resolve(8000)

    expect(mockAuthorizeFygaroTopup).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      username: "jaceth2009",
      level: AccountLevel.One,
      amountCents: 8000,
    })
    expect(result.errors).toEqual([])
    expect(result.checkout).toEqual({
      url: CHECKOUT.url,
      expiresAt: EXPIRES_AT,
      amount: 8000,
    })
    expect(result.remainingAllowance).toBe(2000)
  })

  it("hands expiresAt to the Timestamp scalar as a Date, not a pre-serialised value", async () => {
    // Timestamp serializes from a Date; passing anything else through here
    // surfaces as a scalar error at response time, not at resolve time.
    const result = await resolve(8000)

    expect(result.checkout?.expiresAt).toBeInstanceOf(Date)
    expect(result.checkout?.expiresAt?.getTime()).toBe(EXPIRES_AT.getTime())
  })

  it("refuses before authorising when the account has no username", async () => {
    // custom_reference is how the webhook attributes the payment. Without a
    // username the payment would arrive unattributable — and the customer would
    // already have been charged.
    const result = await resolve(8000, ctx({ username: undefined }))

    expect(mockAuthorizeFygaroTopup).not.toHaveBeenCalled()
    expect(result.checkout).toBeUndefined()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].code).toBe("FYGARO_CHECKOUT_DISABLED")
    expect(result.errors[0].message).toContain("username")
  })

  it("returns the scalar's validation error without authorising", async () => {
    // CentAmount hands the resolver an InputValidationError instead of a number
    // for a negative/oversized amount; it must not reach the authorisation.
    const result = await resolve(
      new InputValidationError({ message: "Invalid value for CentAmount" }),
    )

    expect(mockAuthorizeFygaroTopup).not.toHaveBeenCalled()
    expect(result.errors).toHaveLength(1)
    expect(result.checkout).toBeUndefined()
  })

  it("still reports the remaining allowance on a refusal", async () => {
    // A bare "no" leaves the client unable to say how much WOULD be accepted,
    // which is the whole point of deciding before the charge.
    mockAuthorizeFygaroTopup.mockResolvedValue({
      authorized: false,
      reason: "exceeds-daily-allowance",
      remainingAllowanceCents: 500,
      limitCents: 10000,
    })

    const result = await resolve(8000)

    expect(result.checkout).toBeUndefined()
    expect(result.remainingAllowance).toBe(500)
    expect(result.errors[0].code).toBe("FYGARO_DAILY_ALLOWANCE_EXCEEDED")
    expect(result.errors[0].message).toBe("You have $5.00 left of today's top-up limit")
  })

  it("names the minimum in the below-minimum message", async () => {
    mockAuthorizeFygaroTopup.mockResolvedValue({
      authorized: false,
      reason: "below-minimum",
      minimumCents: 500,
    })

    const result = await resolve(400)

    expect(result.errors[0].code).toBe("FYGARO_BELOW_MINIMUM")
    expect(result.errors[0].message).toBe("The minimum top-up is $5.00")
  })

  it("names the ceiling in the above-single-payment-limit message", async () => {
    mockAuthorizeFygaroTopup.mockResolvedValue({
      authorized: false,
      reason: "above-single-payment-limit",
      limitCents: 20000,
    })

    const result = await resolve(50000)

    expect(result.errors[0].code).toBe("FYGARO_ABOVE_SINGLE_PAYMENT_LIMIT")
    expect(result.errors[0].message).toBe(
      "The most you can top up in one payment is $200.00",
    )
  })

  it("tells a level with no allowance that it is not eligible, not that we are down", async () => {
    // A level-0 account has no configured allowance and never will until it
    // upgrades. Routing it to the two TRANSIENT failures below would tell it to
    // try again later, forever, and send support chasing a phantom outage.
    mockAuthorizeFygaroTopup.mockResolvedValue({
      authorized: false,
      reason: "no-daily-limit-for-level",
    })

    const result = await resolve(8000)

    expect(result.errors[0].code).toBe("FYGARO_LEVEL_NOT_ELIGIBLE")
    expect(result.errors[0].code).not.toBe("FYGARO_ALLOWANCE_UNAVAILABLE")
    expect(result.errors[0].message).toContain("account level")
  })

  it.each([["settings-unavailable"], ["history-unavailable"]])(
    "maps the transient %s to the allowance-unavailable error",
    async (reason) => {
      mockAuthorizeFygaroTopup.mockResolvedValue({ authorized: false, reason })

      const result = await resolve(8000)

      expect(result.errors[0].code).toBe("FYGARO_ALLOWANCE_UNAVAILABLE")
      expect(result.remainingAllowance).toBeUndefined()
    },
  )

  it("maps a fee-eaten amount to a too-small message, not a limit or an outage", async () => {
    mockAuthorizeFygaroTopup.mockResolvedValue({
      authorized: false,
      reason: "non-positive-net",
    })

    const result = await resolve(600)

    expect(result.errors[0].code).toBe("FYGARO_BELOW_MINIMUM")
    expect(result.errors[0].message).toBe(
      "That amount is too small to cover the payment fees",
    )
  })

  it("maps checkout-disabled to its own code", async () => {
    mockAuthorizeFygaroTopup.mockResolvedValue({
      authorized: false,
      reason: "checkout-disabled",
    })

    const result = await resolve(8000)

    expect(result.errors[0].code).toBe("FYGARO_CHECKOUT_DISABLED")
  })
})
