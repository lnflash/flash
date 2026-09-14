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

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
jest.mock("@services/logger", () => ({
  get baseLogger() {
    return mockLogger
  },
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

  describe("fallback-verified requests (key id not in config)", () => {
    // Payments must still flow, but a config map whose key ids don't match
    // what Fygaro sends silently disables the rotation/skew alerts: the next
    // secret rotation would 401 every payment under knownKeyId=false with no
    // page. Surface the mismatch on the SUCCESS path, while everything works.
    it("warns with the configured key ids when verified under an unknown key id", () => {
      const t = nowSeconds()
      const req = makeReq({
        signature: `t=${t},v1=${sign(t, RAW_BODY, "secret-one")}`,
        keyId: "k_9f3a",
      })
      const next = jest.fn()

      verifyFygaroSignature(req, makeRes(), next)

      expect(next).toHaveBeenCalled()
      expect(mockAlertBridge).not.toHaveBeenCalled()
      const fallbackWarn = mockLogger.warn.mock.calls.find(([, msg]) =>
        /verified via fallback/i.test(String(msg)),
      )
      expect(fallbackWarn).toBeDefined()
      expect(fallbackWarn?.[0]).toEqual({
        keyId: "k_9f3a",
        configuredKeyIds: ["key1", "key2"],
      })
      expect(String(fallbackWarn?.[1])).toMatch(/mismatch alert will not fire/i)
      // The skew alert is HMAC-gated and fires under any key id, so the
      // message must not claim it is disabled.
      expect(String(fallbackWarn?.[1])).not.toMatch(/skew/i)
      expect(JSON.stringify(fallbackWarn)).not.toContain("secret-one")
      expect(JSON.stringify(fallbackWarn)).not.toContain("secret-two")
    })

    it("warns when verified with NO key id header", () => {
      const t = nowSeconds()
      const req = makeReq({
        signature: `t=${t},v1=${sign(t, RAW_BODY, "secret-two")}`,
      })
      const next = jest.fn()

      verifyFygaroSignature(req, makeRes(), next)

      expect(next).toHaveBeenCalled()
      expect(
        mockLogger.warn.mock.calls.some(([, msg]) =>
          /verified via fallback/i.test(String(msg)),
        ),
      ).toBe(true)
    })

    it("does NOT warn when verified under a known key id", () => {
      const t = nowSeconds()
      const req = makeReq({
        signature: `t=${t},v1=${sign(t, RAW_BODY, "secret-one")}`,
        keyId: "key1",
      })
      const next = jest.fn()

      verifyFygaroSignature(req, makeRes(), next)

      expect(next).toHaveBeenCalled()
      expect(mockLogger.warn).not.toHaveBeenCalled()
    })
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

    describe("clock-skew alert is unforgeable", () => {
      // The key id is customer-visible by design (JWT `kid` in every checkout
      // URL), so gating the skew page on it alone lets anyone with a checkout
      // link page ops with a fake `t=`. The alert must require the stale
      // request to be correctly signed with a secret we hold.
      it("does NOT alert on a stale timestamp under a KNOWN key id when the HMAC does not verify", () => {
        const t = "1789000000"
        const res = makeRes()
        const next = jest.fn()
        const req = makeReq({
          signature: `t=${t},v1=${sign(t, RAW_BODY, "wrong-secret")}`,
          keyId: "key1",
        })

        verifyFygaroSignature(req, res, next)

        expect(res.status).toHaveBeenCalledWith(401)
        expect(next).not.toHaveBeenCalled()
        expect(mockAlertBridge).not.toHaveBeenCalled()
      })

      it("does NOT alert on a stale timestamp under a KNOWN key id with a malformed hash", () => {
        const t = String(Math.floor(Date.now() / 1000) - 3600)
        const res = makeRes()
        const req = makeReq({ signature: `t=${t},v1=deadbeef`, keyId: "key1" })

        verifyFygaroSignature(req, res, jest.fn())

        expect(res.status).toHaveBeenCalledWith(401)
        expect(mockAlertBridge).not.toHaveBeenCalled()
      })

      it("alerts on a stale timestamp that IS correctly signed, even under an unknown key id", () => {
        // Signed with a secret we hold = genuine Fygaro traffic (or a replay of
        // it) that our clock rejected. That is the NTP signal regardless of
        // whether the key id matched our config map.
        const t = String(Math.floor(Date.now() / 1000) - 3600)
        const res = makeRes()
        const req = makeReq({
          signature: `t=${t},v1=${sign(t, RAW_BODY, "secret-two")}`,
          keyId: "k_9f3a",
        })

        verifyFygaroSignature(req, res, jest.fn())

        expect(res.status).toHaveBeenCalledWith(401)
        expect(mockAlertBridge).toHaveBeenCalledTimes(1)
        // The page carries the raw header key id (not `knownKeyId`) so ops
        // can also see the mis-keyed config while fixing the clock.
        expect(mockAlertBridge.mock.calls[0][0]).toMatchObject({
          dedupKey: "fygaro:clock-skew",
          context: { key_id: "k_9f3a" },
        })
      })

      it("alerts on a stale, correctly signed request with NO key id header and reports key_id undefined", () => {
        const t = String(Math.floor(Date.now() / 1000) - 3600)
        const res = makeRes()
        const req = makeReq({
          signature: `t=${t},v1=${sign(t, RAW_BODY, "secret-two")}`,
        })

        verifyFygaroSignature(req, res, jest.fn())

        expect(res.status).toHaveBeenCalledWith(401)
        expect(mockAlertBridge).toHaveBeenCalledTimes(1)
        expect(mockAlertBridge.mock.calls[0][0]).toMatchObject({
          dedupKey: "fygaro:clock-skew",
          context: { key_id: undefined },
        })
      })

      it("checks the body before the skew window, so a stale request with no body is a 400 and never alerts", () => {
        const t = String(Math.floor(Date.now() / 1000) - 3600)
        const res = makeRes()
        const req = makeReq({
          signature: `t=${t},v1=${sign(t, RAW_BODY, "secret-one")}`,
          keyId: "key1",
          rawBody: "",
        })

        verifyFygaroSignature(req, res, jest.fn())

        expect(res.status).toHaveBeenCalledWith(400)
        expect(mockAlertBridge).not.toHaveBeenCalled()
      })
    })

    describe("unknown key id (probe / scanner / stale credential)", () => {
      // A genuine Fygaro webhook always names the credential it was signed
      // with. A well-formed header under a key id we hold no secret for can
      // only ever fail verification and says nothing about OUR secret or OUR
      // clock — it must be 401'd and logged, never paged. The 2026-09-12
      // test-cluster curl probe (key id "x") paged ops twice for exactly this.
      it("401s a signature mismatch under an unknown key id WITHOUT alerting", () => {
        const t = nowSeconds()
        const res = makeRes()
        const next = jest.fn()
        const req = makeReq({
          signature: `t=${t},v1=${sign(t, RAW_BODY, "wrong-secret")}`,
          keyId: "x",
        })

        verifyFygaroSignature(req, res, next)

        expect(res.status).toHaveBeenCalledWith(401)
        expect(next).not.toHaveBeenCalled()
        expect(mockAlertBridge).not.toHaveBeenCalled()
      })

      it("401s a stale timestamp under an unknown key id WITHOUT alerting", () => {
        // The 2026-09-12 probe: key id "x", t=1789000000, a hash computed
        // with whatever the prober had — never a secret we hold.
        const t = "1789000000"
        const res = makeRes()
        const next = jest.fn()
        const req = makeReq({
          signature: `t=${t},v1=${sign(t, RAW_BODY, "wrong-secret")}`,
          keyId: "x",
        })

        verifyFygaroSignature(req, res, next)

        expect(res.status).toHaveBeenCalledWith(401)
        expect(next).not.toHaveBeenCalled()
        expect(mockAlertBridge).not.toHaveBeenCalled()
      })

      it("401s a signature mismatch with NO key id header WITHOUT alerting", () => {
        // Absent key id: every secret is tried (rotation-friendly) but the
        // request cannot be attributed to a credential we hold, so no page.
        const t = nowSeconds()
        const res = makeRes()
        const req = makeReq({
          signature: `t=${t},v1=${sign(t, RAW_BODY, "wrong-secret")}`,
        })

        verifyFygaroSignature(req, res, jest.fn())

        expect(res.status).toHaveBeenCalledWith(401)
        expect(mockAlertBridge).not.toHaveBeenCalled()
      })

      it("401s a stale timestamp with NO key id header WITHOUT alerting", () => {
        const t = String(Math.floor(Date.now() / 1000) - 3600)
        const res = makeRes()
        const req = makeReq({
          signature: `t=${t},v1=${sign(t, RAW_BODY, "wrong-secret")}`,
        })

        verifyFygaroSignature(req, res, jest.fn())

        expect(res.status).toHaveBeenCalledWith(401)
        expect(mockAlertBridge).not.toHaveBeenCalled()
      })

      it("does not treat inherited object keys as known key ids", () => {
        const t = nowSeconds()
        const res = makeRes()
        const req = makeReq({
          signature: `t=${t},v1=${sign(t, RAW_BODY, "wrong-secret")}`,
          keyId: "constructor",
        })

        verifyFygaroSignature(req, res, jest.fn())

        expect(res.status).toHaveBeenCalledWith(401)
        expect(mockAlertBridge).not.toHaveBeenCalled()
      })

      it("still alerts when NO secrets are configured, even under an unknown key id", () => {
        // That one is our misconfiguration regardless of what the request says.
        mockFygaroConfig.webhook.secrets = {}
        const t = nowSeconds()
        const req = makeReq({
          signature: `t=${t},v1=${sign(t, RAW_BODY, "secret-one")}`,
          keyId: "x",
        })

        verifyFygaroSignature(req, makeRes(), jest.fn())

        expect(mockAlertBridge).toHaveBeenCalledTimes(1)
        expect(mockAlertBridge.mock.calls[0][0]).toMatchObject({
          dedupKey: "fygaro:signature-failure",
        })
      })

      it("still alerts a mismatch under a KNOWN key id (rotated / mispasted secret)", () => {
        const t = nowSeconds()
        const req = makeReq({
          signature: `t=${t},v1=${sign(t, RAW_BODY, "wrong-secret")}`,
          keyId: "key2",
        })

        verifyFygaroSignature(req, makeRes(), jest.fn())

        expect(mockAlertBridge).toHaveBeenCalledTimes(1)
        expect(mockAlertBridge.mock.calls[0][0].context).toEqual({ key_id: "key2" })
      })
    })
  })
})
