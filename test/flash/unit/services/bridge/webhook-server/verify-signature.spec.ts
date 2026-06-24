jest.mock("@config", () => ({
  BridgeConfig: {
    webhook: {
      publicKeys: {
        kyc: "",
        deposit: "",
        transfer: "",
        external_account: "",
      },
      timestampSkewMs: 5 * 60 * 1000,
    },
  },
}))

jest.mock("@services/logger", () => ({
  baseLogger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}))

import crypto from "crypto"

import { NextFunction, Request, Response } from "express"

import { verifyBridgeSignature } from "@services/bridge/webhook-server/middleware/verify-signature"
import { baseLogger } from "@services/logger"

type RawBodyRequest = Request & { rawBody?: string }

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
})

const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString()

const RAW_BODY = JSON.stringify({
  api_version: "v0",
  event_id: "wh_signature_fixture",
  event_category: "customer",
  event_type: "kyc.approved",
  event_object_id: "cust_signature_fixture",
})

const makeRes = () => {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response
  ;(res.status as jest.Mock).mockReturnValue(res)
  ;(res.json as jest.Mock).mockReturnValue(res)
  return res
}

const makeReq = (signature: string, rawBody = RAW_BODY) =>
  ({
    headers: { "x-webhook-signature": signature },
    rawBody,
  }) as unknown as RawBodyRequest

const signBridgeDigestFixture = (timestamp: string, rawBody = RAW_BODY) => {
  const signedPayload = `${timestamp}.${rawBody}`
  const digest = crypto.createHash("sha256").update(signedPayload).digest()
  const signer = crypto.createSign("RSA-SHA256")
  signer.update(digest)
  return signer.sign(privateKey, "base64")
}

const signRawPayloadDirectly = (timestamp: string, rawBody = RAW_BODY) => {
  const signer = crypto.createSign("RSA-SHA256")
  signer.update(`${timestamp}.${rawBody}`)
  return signer.sign(privateKey, "base64")
}

const signatureHeader = (timestamp: string, signature: string) =>
  `t=${timestamp},v0=${signature}`

describe("verifyBridgeSignature", () => {
  beforeAll(() => {
    const { BridgeConfig } = jest.requireMock("@config")
    BridgeConfig.webhook.publicKeys.kyc = publicKeyPem
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("accepts the Bridge documented digest signature over timestamp and exact raw body", () => {
    const timestamp = Date.now().toString()
    const signature = signBridgeDigestFixture(timestamp)
    const req = makeReq(signatureHeader(timestamp, signature))
    const res = makeRes()
    const next = jest.fn() as NextFunction

    verifyBridgeSignature("kyc")(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status as jest.Mock).not.toHaveBeenCalled()
  })

  it("does not log the raw signed payload while verifying signatures", () => {
    const timestamp = Date.now().toString()
    const signature = signBridgeDigestFixture(timestamp)
    const req = makeReq(signatureHeader(timestamp, signature))
    const res = makeRes()
    const next = jest.fn() as NextFunction

    verifyBridgeSignature("kyc")(req, res, next)

    expect(baseLogger.debug).toHaveBeenCalledWith(
      expect.not.objectContaining({ signedPayload: expect.any(String) }),
      "Verifying Bridge webhook signature",
    )
  })

  it("rejects signatures created over the raw timestamp/body payload directly", () => {
    const timestamp = Date.now().toString()
    const signature = signRawPayloadDirectly(timestamp)
    const req = makeReq(signatureHeader(timestamp, signature))
    const res = makeRes()
    const next = jest.fn() as NextFunction

    verifyBridgeSignature("kyc")(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status as jest.Mock).toHaveBeenCalledWith(401)
    expect(res.json as jest.Mock).toHaveBeenCalledWith({ error: "Invalid signature" })
  })

  it("rejects digest signatures generated from a reserialized body instead of the captured raw body", () => {
    const timestamp = Date.now().toString()
    const reserializedBody = JSON.stringify(JSON.parse(RAW_BODY), null, 2)
    const signature = signBridgeDigestFixture(timestamp, reserializedBody)
    const req = makeReq(signatureHeader(timestamp, signature), RAW_BODY)
    const res = makeRes()
    const next = jest.fn() as NextFunction

    verifyBridgeSignature("kyc")(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status as jest.Mock).toHaveBeenCalledWith(401)
    expect(res.json as jest.Mock).toHaveBeenCalledWith({ error: "Invalid signature" })
  })
})
