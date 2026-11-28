import { UsdtCheckoutError, usdtCheckoutService } from "@app/pos-usdt-checkout/checkout"
import { posUsdtFields } from "@graphql/public/pos-usdt/fields"

type Service = ReturnType<typeof usdtCheckoutService>

const ctx = { ip: "192.0.2.15" } as GraphQLPublicContext
const resolve = (field: { resolve?: unknown }, args: unknown) =>
  (field.resolve as (s: unknown, a: unknown, c: unknown, i: unknown) => Promise<unknown>)(
    undefined,
    args,
    ctx,
    {},
  )
const service = (overrides: Partial<Service>) =>
  ({
    supports: jest.fn(async () => true),
    create: jest.fn(),
    status: jest.fn(),
    ingest: jest.fn(),
    ...overrides,
  }) as unknown as Service

it("is off, and says so without detail, when the service is not configured", async () => {
  const fields = posUsdtFields(
    () => null,
    async () => undefined,
  )
  expect(await resolve(fields.supported, { recipientWalletId: "w" })).toBe(false)
  expect(await resolve(fields.status, { id: "x" })).toEqual({
    checkout: null,
    errors: [{ message: "USDT checkout is unavailable." }],
  })
})

it("never forwards an internal error to the public caller", async () => {
  const svc = service({
    supports: jest.fn(async () => {
      throw new Error("mongo at 10.0.0.3 refused")
    }),
    status: jest.fn(async () => {
      throw new Error("IBEX 500 for account 1234")
    }),
  })
  const fields = posUsdtFields(
    () => svc,
    async () => undefined,
  )
  expect(await resolve(fields.supported, { recipientWalletId: "w" })).toBe(false)
  expect(await resolve(fields.status, { id: "x" })).toEqual({
    checkout: null,
    errors: [{ message: "Could not verify this checkout. Retry the same sale." }],
  })
})

it("charges the per-IP budget before the service, and passes POS messages through", async () => {
  const order: string[] = []
  const svc = service({
    create: jest.fn(async () => {
      order.push("create")
      throw new UsdtCheckoutError(
        "This sale reference already has different payment details.",
      )
    }),
  })
  const fields = posUsdtFields(
    () => svc,
    async (ip, operation) => {
      order.push(`${operation}:${ip}`)
    },
  )
  const input = { recipientWalletId: "w", requestId: "a".repeat(64), amountMinor: 500 }
  expect(await resolve(fields.create, { input })).toEqual({
    checkout: null,
    errors: [{ message: "This sale reference already has different payment details." }],
  })
  expect(order).toEqual(["create:192.0.2.15", "create"])
  expect(svc.create).toHaveBeenCalledWith(input, "192.0.2.15")
})
