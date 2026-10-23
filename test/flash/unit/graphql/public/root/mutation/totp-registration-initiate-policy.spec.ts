const mockInitiate = jest.fn()
jest.mock("@app", () => ({
  Authentication: {
    initiateTotpRegistration: (...args: unknown[]) => mockInitiate(...args),
  },
}))

import Mutation from "@graphql/public/root/mutation/user-totp-registration-initiate"
import { DeviceTotpRequiresPhoneUpgradeError } from "@domain/authentication/errors"

const resolve = async (authToken: unknown) =>
  (await Mutation.resolve!(
    null,
    { input: { authToken: authToken as AuthToken } },
    { user: { id: "authenticated-owner" } } as GraphQLPublicContextAuth,
    undefined as never,
  )) as {
    errors: Array<{ code?: string; message: string }>
    totpSecret?: string
    totpRegistrationId?: string
  }

beforeEach(() => jest.resetAllMocks())

it("binds setup to the authenticated GraphQL owner without changing successful payload fields", async () => {
  mockInitiate.mockResolvedValue({
    totpSecret: "fixture-secret",
    totpRegistrationId: "flow",
  })
  expect(await resolve("fixture-token")).toEqual({
    errors: [],
    totpSecret: "fixture-secret",
    totpRegistrationId: "flow",
  })
  expect(mockInitiate).toHaveBeenCalledWith({
    authToken: "fixture-token",
    userId: "authenticated-owner",
  })
})

it("returns the closed upgrade prerequisite without a setup secret", async () => {
  mockInitiate.mockResolvedValue(new DeviceTotpRequiresPhoneUpgradeError())
  const result = await resolve("fixture-token")
  expect(result.errors).toEqual([
    expect.objectContaining({ code: "DEVICE_TOTP_REQUIRES_PHONE_UPGRADE" }),
  ])
  expect(result.totpSecret).toBeUndefined()
  expect(result.totpRegistrationId).toBeUndefined()
})

it("does not invoke enrollment for a rejected input scalar", async () => {
  await resolve(new Error("invalid scalar"))
  expect(mockInitiate).not.toHaveBeenCalled()
})
