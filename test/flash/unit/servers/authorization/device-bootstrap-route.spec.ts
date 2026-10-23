jest.mock("express", () => {
  const routes = new Map<string, unknown>()
  return {
    __esModule: true,
    routes,
    default: {
      Router: () => ({
        use: jest.fn(),
        get: jest.fn(),
        post: (path: string, handler: unknown) => routes.set(path, handler),
      }),
    },
  }
})
const mockLogin = jest.fn(),
  mockAttributes = jest.fn(),
  mockException = jest.fn()
jest.mock("@app", () => ({
  Authentication: { loginWithDevice: (...args: unknown[]) => mockLogin(...args) },
}))
jest.mock("basic-auth", () => ({
  __esModule: true,
  default: (request: { testBasic: unknown }) => request.testBasic,
}))
jest.mock("@graphql/error-map", () => ({ mapError: jest.fn() }))
jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: (...args: unknown[]) => mockAttributes(...args),
  recordExceptionInCurrentSpan: (...args: unknown[]) => mockException(...args),
  tracer: {},
}))
jest.mock("@app/authentication", () => ({}))
jest.mock("@domain/accounts-ips", () => ({ parseIps: jest.fn() }))
jest.mock("@domain/users", () => ({
  checkedToDeviceId: (value: string) => (value.length <= 38 ? value : new Error(value)),
}))
jest.mock("@services/kratos", () => ({}))
jest.mock("@services/kratos/cookie", () => ({}))
jest.mock("@config", () => ({ UNSECURE_IP_FROM_REQUEST_OBJECT: false }))
jest.mock("@app/captcha", () => ({ registerCaptchaGeetest: jest.fn() }))
jest.mock("@servers/authorization/api-key-check", () => ({
  apiKeyCheckHandler: jest.fn(),
}))

import { EventEmitter } from "events"

import type { Request, Response } from "express"

import authRouter from "@servers/authorization"
import { DeviceBootstrapError } from "@domain/authentication/device-bootstrap-error"

const DEVICE = "11111111-1111-4111-8111-111111111111",
  PASSWORD = "22222222-2222-4222-8222-222222222222"
const handler = () =>
  jest.requireMock("express").routes.get("/create/device-account") as (
    request: Request,
    response: Response,
  ) => Promise<unknown>
const fixture = (name: string = DEVICE) => {
  const request = Object.assign(new EventEmitter(), {
    testBasic: { name, pass: PASSWORD },
    originalIp: "127.0.0.1",
  })
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    status: jest.fn(),
    send: jest.fn(),
  })
  response.status.mockReturnValue(response)
  response.send.mockImplementation(() => {
    response.writableEnded = true
    return response
  })
  return {
    request,
    response,
    call: () => handler()(request as unknown as Request, response as unknown as Response),
  }
}
beforeEach(() => {
  jest.clearAllMocks()
  mockLogin.mockResolvedValue("fixture-token")
})

it("keeps success response compatible and emits fixed method/readiness attributes only", async () => {
  expect(authRouter).toBeDefined()
  const f = fixture()
  await f.call()
  expect(f.response.status).toHaveBeenCalledWith(200)
  expect(f.response.send).toHaveBeenCalledWith({ result: "fixture-token" })
  expect(mockAttributes).toHaveBeenCalledWith({
    "login.method": "device",
    "login.deviceBootstrapReady": true,
  })
  expect(JSON.stringify(mockAttributes.mock.calls)).not.toContain(DEVICE)
  expect(JSON.stringify(mockAttributes.mock.calls)).not.toContain(PASSWORD)
  expect(f.request.listenerCount("aborted")).toBe(0)
  expect(f.response.listenerCount("close")).toBe(0)
})
it("does not echo a malformed private Basic username in the response or telemetry", async () => {
  const privateUsername = "PRIVATE_BASIC_IDENTIFIER_".repeat(4)
  const f = fixture(privateUsername)
  await f.call()
  expect(f.response.status).toHaveBeenCalledWith(422)
  expect(f.response.send).toHaveBeenCalledWith({ error: "Invalid device credentials" })
  expect(JSON.stringify(f.response.send.mock.calls)).not.toContain(privateUsername)
  expect(mockLogin).not.toHaveBeenCalled()
  expect(mockAttributes).not.toHaveBeenCalled()
})
it.each([
  "DEVICE_BOOTSTRAP_SUPPORT_REQUIRED",
  "DEVICE_BOOTSTRAP_RETRY_REQUIRED",
  "DEVICE_BOOTSTRAP_OWNER_MISMATCH",
  "DEVICE_BOOTSTRAP_INCOMPATIBLE_IDENTITY",
] as const)(
  "adds safe machinecode %s without returning a provisional token",
  async (code) => {
    mockLogin.mockResolvedValue(new DeviceBootstrapError(code))
    const f = fixture()
    await f.call()
    expect(f.response.status).toHaveBeenCalledWith(500)
    expect(f.response.send.mock.calls[0][0]).toMatchObject({ code })
    expect(f.response.send.mock.calls[0][0]).not.toHaveProperty("result")
  },
)
it("propagates disconnect cancellation and never sends a late token", async () => {
  let resolve: ((value: string) => void) | undefined
  mockLogin.mockImplementation(
    () =>
      new Promise<string>((done) => {
        resolve = done
      }),
  )
  const f = fixture()
  const pending = f.call()
  expect(mockLogin.mock.calls[0][0].signal.aborted).toBe(false)
  f.response.emit("close")
  expect(mockLogin.mock.calls[0][0].signal.aborted).toBe(true)
  resolve?.("fixture-token")
  await pending
  expect(f.response.send).not.toHaveBeenCalled()
})
it("sanitizes unexpected exceptions before tracing or responding", async () => {
  mockLogin.mockRejectedValue(new Error(PASSWORD))
  const f = fixture()
  await f.call()
  expect(f.response.send.mock.calls[0][0].code).toBe("DEVICE_BOOTSTRAP_RETRY_REQUIRED")
  expect(JSON.stringify(f.response.send.mock.calls)).not.toContain(PASSWORD)
  expect(JSON.stringify(mockException.mock.calls)).not.toContain(PASSWORD)
})
