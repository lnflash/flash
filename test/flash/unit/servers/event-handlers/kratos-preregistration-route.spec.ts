import { Request, Response } from "express"

import { Authentication } from "@app"
import {
  InvalidSecretForAuthNCallbackError,
  MissingRegistrationPayloadPropertiesError,
  PhoneAlreadyExistsError,
} from "@domain/authentication/errors"
import { InvalidPhoneNumber, UnknownRepositoryError } from "@domain/errors"
import { InvalidCarrierTypeForPhoneMetadataError } from "@domain/users/errors"
import kratosCallback from "@servers/event-handlers/kratos"

jest.mock("@app", () => ({
  Authentication: {
    validatePreRegistrationPayload: jest.fn(),
    createAccountFromRegistrationPayload: jest.fn(),
  },
}))

const mockValidate = Authentication.validatePreRegistrationPayload as jest.MockedFunction<
  typeof Authentication.validatePreRegistrationPayload
>

type RouteLayer = {
  route?: { path: string; stack: { handle: (req: Request, res: Response) => unknown }[] }
}

const handlerFor = (path: string) => {
  const layer = (kratosCallback as unknown as { stack: RouteLayer[] }).stack.find(
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

// Kratos sends the nil uuid here: the identity is not persisted yet.
const NIL_UUID = "00000000-0000-0000-0000-000000000000"

const makeReq = (bodyOverrides: Record<string, unknown> = {}) =>
  ({
    headers: { authorization: "callback-key" },
    body: {
      identity_id: NIL_UUID,
      phone: "+2348012345678",
      schema_id: "phone_no_password_v0",
      transient_payload: {
        phoneMetadata: { carrier: { type: "mobile" }, countryCode: "NG" },
      },
      flow_id: "flow",
      flow_type: "api",
      ...bodyOverrides,
    },
  }) as unknown as Request

const rejection = (id: number, text: string) => ({
  messages: [{ instance_ptr: "#/traits/phone", messages: [{ id, text, type: "error" }] }],
})

describe("POST /kratos/preregistration", () => {
  const handler = handlerFor("/preregistration")

  beforeEach(() => mockValidate.mockReset())

  it("answers 200 with an empty JSON object when validation passes", async () => {
    mockValidate.mockResolvedValue(true)
    const res = makeRes()

    await handler(makeReq(), res)

    expect(mockValidate).toHaveBeenCalledWith({
      secret: "callback-key",
      body: expect.objectContaining({ identity_id: NIL_UUID, phone: "+2348012345678" }),
    })
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({})
    expect(res.send).not.toHaveBeenCalled()
  })

  it("answers 400 with the Kratos messages body on a carrier-type rejection", async () => {
    mockValidate.mockResolvedValue(new InvalidCarrierTypeForPhoneMetadataError())
    const res = makeRes()

    await handler(makeReq(), res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      rejection(4100001, "This phone number can't be used to sign up."),
    )
  })

  it("answers 400 'not allowed' for an unparseable phone", async () => {
    mockValidate.mockResolvedValue(new InvalidPhoneNumber())
    const res = makeRes()

    await handler(makeReq({ phone: "nope" }), res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      rejection(4100001, "This phone number can't be used to sign up."),
    )
  })

  it("answers 400 'already registered' when the phone is bound to another identity", async () => {
    mockValidate.mockResolvedValue(new PhoneAlreadyExistsError())
    const res = makeRes()

    await handler(makeReq(), res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      rejection(4100002, "This phone number is already registered."),
    )
  })

  it("answers 400 'payload invalid' when the hook body itself is malformed", async () => {
    mockValidate.mockResolvedValue(new MissingRegistrationPayloadPropertiesError())
    const res = makeRes()

    await handler(makeReq({ phone: undefined }), res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      rejection(4100003, "Sign-up request was invalid. Please try again."),
    )
  })

  it("answers 401 as JSON on a bad callback secret", async () => {
    mockValidate.mockResolvedValue(new InvalidSecretForAuthNCallbackError())
    const res = makeRes()

    await handler(makeReq(), res)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith(
      rejection(4100401, "Sign-up is temporarily unavailable."),
    )
    expect(res.send).not.toHaveBeenCalled()
  })

  it("answers 500 as JSON (never plain text) on an unexpected error", async () => {
    mockValidate.mockResolvedValue(new UnknownRepositoryError("mongo down"))
    const res = makeRes()

    await handler(makeReq(), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith(
      rejection(4100500, "Sign-up is temporarily unavailable. Please try again."),
    )
    expect(res.send).not.toHaveBeenCalled()
  })

  it("tolerates a missing body", async () => {
    mockValidate.mockResolvedValue(new MissingRegistrationPayloadPropertiesError())
    const res = makeRes()

    await handler({ headers: {}, body: undefined } as unknown as Request, res)

    expect(mockValidate).toHaveBeenCalledWith({ secret: undefined, body: {} })
    expect(res.status).toHaveBeenCalledWith(400)
  })
})

describe("POST /kratos/registration is unchanged", () => {
  it("is still registered after the pre-registration route", () => {
    expect(() => handlerFor("/registration")).not.toThrow()
  })
})
