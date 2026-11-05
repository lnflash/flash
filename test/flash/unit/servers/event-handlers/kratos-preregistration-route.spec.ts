import { Request, Response } from "express"

import { Authentication } from "@app"
import {
  InvalidSecretForAuthNCallbackError,
  MissingRegistrationPayloadPropertiesError,
  PhoneAlreadyRegisteredError,
  UnsupportedSchemaTypeError,
} from "@domain/authentication/errors"
import { InvalidPhoneNumber, UnknownRepositoryError } from "@domain/errors"
import {
  InvalidCarrierForPhoneMetadataError,
  InvalidCarrierTypeForPhoneMetadataError,
  InvalidCountryCodeForPhoneMetadataError,
  PhoneMetadataValidationError,
} from "@domain/users/errors"
import kratosCallback from "@servers/event-handlers/kratos"
import { baseLogger } from "@services/logger"

jest.mock("@app", () => ({
  Authentication: {
    validatePreRegistrationPayload: jest.fn(),
    createAccountFromRegistrationPayload: jest.fn(),
  },
}))
jest.mock("@services/tracing", () => ({
  wrapAsyncToRunInSpan: ({ fn }: { fn: unknown }) => fn,
}))
jest.mock("@services/logger", () => ({
  baseLogger: { error: jest.fn(), warn: jest.fn() },
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

  beforeEach(() => {
    jest.clearAllMocks()
    mockValidate.mockReset()
  })

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

  it.each([
    ["carrier type", new InvalidCarrierTypeForPhoneMetadataError()],
    ["carrier shape", new InvalidCarrierForPhoneMetadataError()],
    ["country code", new InvalidCountryCodeForPhoneMetadataError()],
  ])(
    "answers 400 with the Kratos messages body on a %s rejection",
    async (_label, err) => {
      // The route matches the parent class; every carrier error must be one.
      expect(err).toBeInstanceOf(PhoneMetadataValidationError)
      mockValidate.mockResolvedValue(err)
      const res = makeRes()

      await handler(makeReq(), res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith(
        rejection(4100001, "This phone number can't be used to sign up."),
      )
    },
  )

  it("answers 400 'not allowed' for an unparsable phone", async () => {
    mockValidate.mockResolvedValue(new InvalidPhoneNumber())
    const res = makeRes()

    await handler(makeReq({ phone: "nope" }), res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      rejection(4100001, "This phone number can't be used to sign up."),
    )
  })

  it("answers 400 'already registered' when the phone is bound to another identity", async () => {
    mockValidate.mockResolvedValue(new PhoneAlreadyRegisteredError())
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

  it("logs a malformed hook payload at error, not warn: Kratos config and the api disagree", async () => {
    const errorSpy = jest.spyOn(baseLogger, "error").mockImplementation(() => undefined)
    const warnSpy = jest.spyOn(baseLogger, "warn").mockImplementation(() => undefined)
    try {
      mockValidate.mockResolvedValue(new UnsupportedSchemaTypeError())

      await handler(makeReq({ schema_id: "email_no_password_v0" }), makeRes())

      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "invalid_payload",
          expectedSchema: "phone_no_password_v0",
        }),
        "Kratos callback failed",
      )
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it("logs a phone-policy rejection at warn: expected, not a defect", async () => {
    const errorSpy = jest.spyOn(baseLogger, "error").mockImplementation(() => undefined)
    const warnSpy = jest.spyOn(baseLogger, "warn").mockImplementation(() => undefined)
    try {
      mockValidate.mockResolvedValue(new InvalidCarrierTypeForPhoneMetadataError())

      await handler(makeReq(), makeRes())

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "phone_not_allowed" }),
        "Kratos callback failed",
      )
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
      warnSpy.mockRestore()
    }
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

describe("Kratos callback telemetry privacy", () => {
  beforeEach(() => jest.clearAllMocks())
  const cases = [
    {
      path: "/registration",
      label: "bad secret",
      error: new InvalidSecretForAuthNCallbackError("PRIVATE_ERROR"),
      status: 401,
    },
    {
      path: "/registration",
      label: "invalid payload",
      error: new MissingRegistrationPayloadPropertiesError("PRIVATE_ERROR"),
      status: 400,
    },
    {
      path: "/registration",
      label: "creation failure",
      error: new UnknownRepositoryError("PRIVATE_ERROR"),
      status: 500,
    },
    {
      path: "/preregistration",
      label: "bad secret",
      error: new InvalidSecretForAuthNCallbackError("PRIVATE_ERROR"),
      status: 401,
    },
    {
      path: "/preregistration",
      label: "existing phone",
      error: new PhoneAlreadyRegisteredError("PRIVATE_ERROR"),
      status: 400,
    },
    {
      path: "/preregistration",
      label: "invalid phone",
      error: new InvalidPhoneNumber("PRIVATE_PHONE"),
      status: 400,
    },
    {
      path: "/preregistration",
      label: "metadata refusal",
      error: new InvalidCarrierTypeForPhoneMetadataError("PRIVATE_ERROR"),
      status: 400,
    },
    {
      path: "/preregistration",
      label: "invalid payload",
      error: new UnsupportedSchemaTypeError("PRIVATE_SCHEMA"),
      status: 400,
    },
    {
      path: "/preregistration",
      label: "unexpected failure",
      error: new UnknownRepositoryError("PRIVATE_ERROR"),
      status: 500,
    },
  ]
  const noPrivateTelemetry = () => {
    const logged = JSON.stringify(
      [jest.mocked(baseLogger.error).mock.calls, jest.mocked(baseLogger.warn).mock.calls],
      (_key, value) =>
        value instanceof Error
          ? { ...value, message: value.message, stack: value.stack }
          : value,
    )
    expect(logged).not.toContain("PRIVATE_")
  }
  it.each(cases)(
    "preserves $path $label refusal without logging inputs/errors",
    async ({ path, error, status }) => {
      const req = makeReq({
        phone: "PRIVATE_PHONE",
        schema_id: "PRIVATE_SCHEMA",
        password: "PRIVATE_PASSWORD",
        identity_id: "PRIVATE_ID",
      })
      req.headers.authorization = "PRIVATE_CALLBACK_SECRET"
      // Both functions are module mocks; avoid expanding the complete
      // ApplicationError union through Jest's deep-mocked conditional type.
      const service: jest.Mock =
        path === "/registration"
          ? (Authentication.createAccountFromRegistrationPayload as jest.Mock)
          : (mockValidate as jest.Mock)
      service.mockResolvedValue(error)
      const res = makeRes()
      await handlerFor(path)(req, res)
      expect(res.status).toHaveBeenCalledWith(status)
      expect(service).toHaveBeenCalledWith({
        secret: "PRIVATE_CALLBACK_SECRET",
        body: req.body,
      })
      noPrivateTelemetry()
      expect(JSON.stringify([res.json.mock.calls, res.send.mock.calls])).not.toContain(
        "PRIVATE_",
      )
    },
  )

  it.each(["/registration", "/preregistration"])(
    "contains rejected %s work inside a safe callback failure boundary",
    async (path) => {
      const service: jest.Mock =
        path === "/registration"
          ? (Authentication.createAccountFromRegistrationPayload as jest.Mock)
          : (mockValidate as jest.Mock)
      service.mockRejectedValue(new Error("PRIVATE_AXIOS_BODY PRIVATE_API_KEY"))
      const res = makeRes()
      await expect(
        Promise.resolve(handlerFor(path)(makeReq({ phone: "PRIVATE_PHONE" }), res)),
      ).resolves.toBeUndefined()
      expect(res.status).toHaveBeenCalledWith(500)
      noPrivateTelemetry()
      expect(JSON.stringify([res.json.mock.calls, res.send.mock.calls])).not.toContain(
        "PRIVATE_",
      )
    },
  )
})
