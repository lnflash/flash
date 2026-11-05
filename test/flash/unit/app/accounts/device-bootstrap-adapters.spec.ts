jest.mock("@services/mongoose/device-bootstrap", () => ({
  DeviceBootstrapRepository: jest.fn(() => ({})),
}))
jest.mock("@services/kratos/device-bootstrap-identity", () => ({
  readDeviceBootstrapIdentity: jest.fn(),
}))
jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: { createAccount: jest.fn() },
}))
const mockLock = jest.fn()
jest.mock("@services/lock", () => ({
  LockService: () => ({ lockAccountId: (...args: unknown[]) => mockLock(...args) }),
}))

import { deviceBootstrapDependencies } from "@app/accounts/device-bootstrap-adapters"
import { DeviceBootstrapError } from "@domain/authentication/device-bootstrap-error"

beforeEach(() => {
  jest.resetAllMocks()
  mockLock.mockImplementation(
    async (_id: string, callback: (signal: { aborted: boolean }) => Promise<unknown>) => {
      // The actual adapter converts callback throws into a generic lock error.
      try {
        return await callback({ aborted: false })
      } catch {
        return new Error("Converted lock callback error")
      }
    },
  )
})
it.each([
  "DEVICE_BOOTSTRAP_SUPPORT_REQUIRED",
  "DEVICE_BOOTSTRAP_RETRY_REQUIRED",
  "DEVICE_BOOTSTRAP_OWNER_MISMATCH",
  "DEVICE_BOOTSTRAP_INCOMPATIBLE_IDENTITY",
] as const)(
  "preserves %s through the real callback-conversion boundary",
  async (code) => {
    await expect(
      deviceBootstrapDependencies().withAccountLock("owned-account", async () => {
        throw new DeviceBootstrapError(code)
      }),
    ).rejects.toMatchObject({ code })
  },
)
it("does not expose an unknown callback exception to the lock converter or caller", async () => {
  const result = await deviceBootstrapDependencies()
    .withAccountLock("owned-account", async () => {
      throw new Error("PRIVATE_PROVIDER_EXCEPTION")
    })
    .catch((error: unknown) => error)
  expect(result).toBeInstanceOf(DeviceBootstrapError)
  expect((result as Error).message).not.toContain("PRIVATE_PROVIDER_EXCEPTION")
})
it("preserves successful callback values and never takes an extra nested account lock", async () => {
  expect(
    await deviceBootstrapDependencies().withAccountLock(
      "owned-account",
      async () => true,
    ),
  ).toBe(true)
  expect(mockLock).toHaveBeenCalledTimes(1)
})
