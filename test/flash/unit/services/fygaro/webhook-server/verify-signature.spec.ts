import crypto from "crypto"

import { Request, Response } from "express"

const mockFygaroConfig = {
  enabled: true,
  webhook: {
    port: 4010,
    secrets: { key1: "secret-one", key2: "secret-two" } as Record<string, string>,
    timestampSkewMs: 300000,
  },
  credit: { enabled: false },
}

jest.mock("@config", () => ({
  get FygaroConfig() {
    return mockFygaroConfig
  },
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const mockAlertBridge = jest.fn()
jest.mock("@services/alerts", () => ({
  alertBridge: (...args: unknown[]) => mockAlertBridge(...args),
  generateDedupKey: {
    fygaroSignatureFailure: () => "fygaro:signature-failure",
    fygaroClockSkew: () => "fygaro:clock-skew",
  },
}))

import { verifyFygaroSignature } from "@services/fygaro/webhook-server/middleware/verify-signature"

const RAW_BODY = JSON.stringify({ transactionId: "tx-1", amount: "10.00" })

const sign = (timestamp: string, rawBody: string, secret: string): string =>
  crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")

const nowSeconds = () => String(Math.floor(Date.now() / 1000))

const makeRes = (): Response => {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response
  ;(res.status as jest.Mock).mockReturnValue(res)
  ;(res.json as jest.Mock).mockReturnValue(res)
  return res
}

const makeReq = ({
  signature,
  keyId,
  rawBody = RAW_BODY,
}: {
  signature?: string
  keyId?: string
  rawBody?: string
}): Request =>
  ({
    headers: {
      ...(signature !== undefined ? { "fygaro-signature": signature } : {}),
      ...(keyId !== undefined ? { "fygaro-key-id": keyId } : {}),
    },
    rawBody,
  }) as unknown as Request

beforeEach(() => {
  jest.clearAllMocks()
  mockFygaroConfig.webhook.secrets = { key1: "secret-one", key2: "secret-two" }
})

describe("verifyFygaroSignature", () => {
  it("accepts a valid signature for the key id's secret", () => {
    const t = nowSeconds()
    const req = makeReq({
      signature: `t=${t},v1=${sign(t, RAW_BODY, "secret-one")}`,
      keyId: "key1",
    })
    const res = makeRes()
    const next = jest.fn()

    verifyFygaroSignature(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it("accepts a valid signature without a key id by trying all secrets", () => {
    const t = nowSeconds()
    const req = makeReq({
      signature: `t=${t},v1=${sign(t, RAW_BODY, "secret-two")}`,
    })
    const res = makeRes()
    const next = jest.fn()

    verifyFygaroSignature(req, res, next)

    expect(next).toHaveBeenCalled()
  })

  it("accepts when one of multiple v1 hashes matches (secret rotation)", () => {
    const t = nowSeconds()
    const stale = sign(t, RAW_BODY, "retired-secret")
    const good = sign(t, RAW_BODY, "secret-one")
    const req = makeReq({ signature: `t=${t},v1=${stale},v1=${good}`, keyId: "key1" })
    const res = makeRes()
    const next = jest.fn()

    verifyFygaroSignature(req, res, next)

    expect(next).toHaveBeenCalled()
  })

  it("accepts a millisecond timestamp within skew", () => {
    const t = String(Date.now())
    const req = makeReq({
      signature: `t=${t},v1=${sign(t, RAW_BODY, "secret-one")}`,
      keyId: "key1",
    })
    const res = makeRes()
    const next = jest.fn()

    verifyFygaroSignature(req, res, next)

    expect(next).toHaveBeenCalled()
  })

  it("rejects a wrong signature with 401", () => {
    const t = nowSeconds()
    const req = makeReq({
      signature: `t=${t},v1=${sign(t, RAW_BODY, "wrong-secret")}`,
      keyId: "key1",
    })
    const res = makeRes()
    const next = jest.fn()

    verifyFygaroSignature(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
  })

  it("rejects a signature computed over a different body", () => {
    const t = nowSeconds()
    const req = makeReq({
      signature: `t=${t},v1=${sign(t, `{"tampered":true}`, "secret-one")}`,
      keyId: "key1",
    })
    const res = makeRes()
    const next = jest.fn()

    verifyFygaroSignature(req, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
  })

  it("rejects a missing signature header with 401", () => {
    const req = makeReq({})
    const res = makeRes()
    const next = jest.fn()

    verifyFygaroSignature(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
  })

  it("rejects a malformed signature header with 401", () => {
    const req = makeReq({ signature: "not-a-signature" })
    const res = makeRes()
    const next = jest.fn()

    verifyFygaroSignature(req, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
  })

  it("rejects a timestamp outside the allowed skew with 401", () => {
    const t = String(Math.floor(Date.now() / 1000) - 3600)
    const req = makeReq({
      signature: `t=${t},v1=${sign(t, RAW_BODY, "secret-one")}`,
      keyId: "key1",
    })
    const res = makeRes()
    const next = jest.fn()

    verifyFygaroSignature(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
  })

  it("rejects with 401 when no secrets are configured", () => {
    mockFygaroConfig.webhook.secrets = {}
    const t = nowSeconds()
    const req = makeReq({
      signature: `t=${t},v1=${sign(t, RAW_BODY, "secret-one")}`,
      keyId: "key1",
    })
    const res = makeRes()
    const next = jest.fn()

    verifyFygaroSignature(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
  })

  it("rejects with 400 when the raw body was not captured", () => {
    const t = nowSeconds()
    const req = makeReq({
      signature: `t=${t},v1=${sign(t, RAW_BODY, "secret-one")}`,
      keyId: "key1",
      rawBody: "",
    })
    const res = makeRes()
    const next = jest.fn()

    verifyFygaroSignature(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
  })

  describe("signature-failure alerting", () => {
    it("alerts (warning, static dedup key) on a signature mismatch, without the secret", () => {
      const t = nowSeconds()
      const req = makeReq({
        signature: `t=${t},v1=${sign(t, RAW_BODY, "wrong-secret")}`,
        keyId: "key1",
      })

      verifyFygaroSignature(req, makeRes(), jest.fn())

      expect(mockAlertBridge).toHaveBeenCalledTimes(1)
      const alert = mockAlertBridge.mock.calls[0][0]
      expect(alert).toMatchObject({
        dedupKey: "fygaro:signature-failure",
        source: "fygaro-webhook",
        severity: "warning",
      })
      expect(alert.title).toMatch(/signature verification failing/i)
      // The key id is safe to include; the secret never is.
      expect(alert.context).toEqual({ key_id: "key1" })
      expect(JSON.stringify(alert)).not.toContain("secret-one")
      expect(JSON.stringify(alert)).not.toContain("wrong-secret")
    })

    it("alerts when no webhook secrets are configured", () => {
      mockFygaroConfig.webhook.secrets = {}
      const t = nowSeconds()
      const req = makeReq({
        signature: `t=${t},v1=${sign(t, RAW_BODY, "secret-one")}`,
        keyId: "key1",
      })

      verifyFygaroSignature(req, makeRes(), jest.fn())

      expect(mockAlertBridge).toHaveBeenCalledTimes(1)
      expect(mockAlertBridge.mock.calls[0][0]).toMatchObject({
        dedupKey: "fygaro:signature-failure",
        severity: "warning",
      })
    })

    it("does NOT alert on a missing signature header (random internet noise)", () => {
      verifyFygaroSignature(makeReq({}), makeRes(), jest.fn())

      expect(mockAlertBridge).not.toHaveBeenCalled()
    })

    it("does NOT alert on a malformed signature header", () => {
      verifyFygaroSignature(
        makeReq({ signature: "not-a-signature" }),
        makeRes(),
        jest.fn(),
      )

      expect(mockAlertBridge).not.toHaveBeenCalled()
    })

    it("alerts on a timestamp outside skew under its OWN dedup key (stuck clock / NTP)", () => {
      // A systematic skew 401s every real webhook while the service looks
      // healthy — the same silent-misconfig class the secret alerts guard
      // against. It must page, but under a DISTINCT static dedup key so replayed
      // old webhooks collapse to one warning per window and it never masks (or is
      // masked by) a bad-secret alert.
      const t = String(Math.floor(Date.now() / 1000) - 3600)
      const req = makeReq({
        signature: `t=${t},v1=${sign(t, RAW_BODY, "secret-one")}`,
        keyId: "key1",
      })

      verifyFygaroSignature(req, makeRes(), jest.fn())

      expect(mockAlertBridge).toHaveBeenCalledTimes(1)
      const alert = mockAlertBridge.mock.calls[0][0]
      expect(alert).toMatchObject({
        dedupKey: "fygaro:clock-skew",
        source: "fygaro-webhook",
        severity: "warning",
      })
      // Distinct from the signature-failure alerts so the two never collapse.
      expect(alert.dedupKey).not.toBe("fygaro:signature-failure")
      expect(alert.title).toMatch(/skew|clock/i)
      expect(alert.context).toEqual({ key_id: "key1" })
    })
  })
})
