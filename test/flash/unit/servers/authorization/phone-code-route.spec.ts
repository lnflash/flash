import { Request, Response } from "express"

import { Authentication } from "@app"
import { PhoneCountryNotAllowedError } from "@domain/users/errors"
import { InvalidPhoneNumber } from "@domain/errors"
import authRouter from "@servers/authorization"

jest.mock("@app", () => ({
  Authentication: {
    requestPhoneCodeWithCaptcha: jest.fn(),
  },
}))

// The router is only reachable in a unit test if its transitive service imports
// (kratos clients, redis-backed rate limiters, the captcha SDK) never open a
// socket at import time.
jest.mock("@app/authentication", () => ({
  elevatingSessionWithTotp: jest.fn(),
  loginWithEmailCookie: jest.fn(),
  loginWithEmailToken: jest.fn(),
  logoutCookie: jest.fn(),
  requestEmailCode: jest.fn(),
}))

jest.mock("@app/captcha", () => ({ registerCaptchaGeetest: jest.fn() }))

jest.mock("@services/kratos", () => ({
  checkedToAuthToken: jest.fn(),
  checkedToEmailLoginId: jest.fn(),
  checkedToTotpCode: jest.fn(),
  validateKratosCookie: jest.fn(),
}))

jest.mock("@services/kratos/cookie", () => ({ parseKratosCookies: jest.fn() }))

const mockedRequestPhoneCode =
  Authentication.requestPhoneCodeWithCaptcha as jest.MockedFunction<
    typeof Authentication.requestPhoneCodeWithCaptcha
  >

type RouteLayer = {
  route?: { path: string; stack: { handle: (req: Request, res: Response) => unknown }[] }
}

const handlerFor = (path: string) => {
  const layer = (authRouter as unknown as { stack: RouteLayer[] }).stack.find(
    (l) => l.route?.path === path,
  )
  if (!layer?.route) throw new Error(`no route registered at ${path}`)
  return layer.route.stack[0].handle
}

const makeRes = () => {
  const res = { status: jest.fn(), json: jest.fn(), send: jest.fn() }
  res.status.mockReturnValue(res)
  return res as unknown as Response & {
    status: jest.Mock
    json: jest.Mock
    send: jest.Mock
  }
}

const makeReq = () =>
  ({
    originalIp: "1.2.3.4",
    body: {
      phone: "+18761234567",
      challengeCode: "challenge",
      validationCode: "validate",
      secCode: "seccode",
      channel: "SMS",
    },
  }) as unknown as Request

// `res.json({ error: someError })` serializes to `{}` — an Error's `name` and
// `message` are non-enumerable — so every message the error map produces was
// invisible on this route, and the client got `{"error":{}}`. /phone/login two
// functions down already sends the mapped message.
describe("POST /auth/phone/code error responses", () => {
  beforeEach(() => mockedRequestPhoneCode.mockReset())

  it("returns the mapped message for a blocked country, not an empty object", async () => {
    mockedRequestPhoneCode.mockResolvedValue(new PhoneCountryNotAllowedError())
    const res = makeRes()

    await handlerFor("/phone/code")(makeReq(), res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({
      error: "Phone number is not from a valid region",
    })
  })

  it("distinguishes an unparsable number from a blocked country", async () => {
    mockedRequestPhoneCode.mockResolvedValue(
      new InvalidPhoneNumber("+000" as PhoneNumber),
    )
    const res = makeRes()

    await handlerFor("/phone/code")(makeReq(), res)

    expect(res.status).toHaveBeenCalledWith(400)
    const [[body]] = res.json.mock.calls
    expect(typeof body.error).toBe("string")
    expect(body.error).not.toBe("Phone number is not from a valid region")
    expect(body.error.length).toBeGreaterThan(0)
  })

  it("still reports success without an error body", async () => {
    mockedRequestPhoneCode.mockResolvedValue(true)
    const res = makeRes()

    await handlerFor("/phone/code")(makeReq(), res)

    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ success: true })
  })
})
