import { LiveUpdateError, LiveUpdateService } from "@app/pos-usdt-checkout/live-updates"
import { posUsdtLiveFields } from "@graphql/public/pos-usdt/live-fields"

const ctx = { ip: "192.0.2.15" } as GraphQLPublicContext
const resolve = (field: { resolve?: unknown }, args: unknown) =>
  (field.resolve as (s: unknown, a: unknown, c: unknown, i: unknown) => Promise<unknown>)(
    undefined,
    args,
    ctx,
    {},
  )
const input = {
  action: "ENROLL",
  receiptId: "a".repeat(64),
  saleKey: "b".repeat(64),
  activityId: "6A1F3C2E-0B4D-4E5F-8A9B-000000000001",
  tokenSequence: 1,
  pushToken: "0f".repeat(32),
}
const service = (consent: jest.Mock) =>
  ({ consent, runDue: jest.fn() }) as unknown as LiveUpdateService

it("is off, and says so, when live updates are not configured", async () => {
  const fields = posUsdtLiveFields(() => null)
  expect(await resolve(fields.consent, { input })).toEqual({
    accepted: false,
    errors: [{ message: "Live updates are unavailable." }],
  })
})

it("passes the input and caller IP through and accepts", async () => {
  const consent = jest.fn().mockResolvedValue("enrolled")
  const fields = posUsdtLiveFields(() => service(consent))
  expect(await resolve(fields.consent, { input })).toEqual({ accepted: true, errors: [] })
  expect(consent).toHaveBeenCalledWith(input, "192.0.2.15")
})

it("forwards only messages written for the app", async () => {
  const consent = jest
    .fn()
    .mockRejectedValueOnce(new LiveUpdateError("Unknown checkout."))
    .mockRejectedValueOnce(new Error("mongo 10.0.0.3 token " + input.pushToken))
  const fields = posUsdtLiveFields(() => service(consent))
  expect(await resolve(fields.consent, { input })).toEqual({
    accepted: false,
    errors: [{ message: "Unknown checkout." }],
  })
  expect(await resolve(fields.consent, { input })).toEqual({
    accepted: false,
    errors: [{ message: "Live updates are temporarily unavailable." }],
  })
})
