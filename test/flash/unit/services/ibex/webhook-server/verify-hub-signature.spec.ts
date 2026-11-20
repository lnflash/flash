import { generateKeyPairSync, sign, KeyObject } from "crypto"

// IBEX Hub's organization webhook (ENG-891) carries no shared secret: each
// delivery is Ed25519-signed over "{webhook-id}.{webhook-timestamp}.{raw body}"
// with a key unique to the webhook (Standard Webhooks, "v1a,<base64>").

const mockHub = { publicKey: "", allowedIps: [] as string[] }
jest.mock("@config", () => ({
  IbexConfig: {
    webhook: {
      get hub() {
        return mockHub
      },
    },
  },
}))
jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

type Module =
  typeof import("@services/ibex/webhook-server/middleware/verify-hub-signature")

// Required, not imported: the module reads the hub config when it loads, and
// an import would run before mockHub exists.
const { checkHubSignature, HUB_SIGNATURE_TOLERANCE_SECONDS, parseHubPublicKey } =
  jest.requireActual<Module>(
    "@services/ibex/webhook-server/middleware/verify-hub-signature",
  )

const NOW = 1_795_184_000
const ID = "msg_2f5c1b0e-6a1d-4b0e-9a57-0c1f0f3c9d11"

// The raw 32-byte key, base64, as Create Webhook returns it.
const rawPublicKeyB64 = (key: KeyObject) =>
  (key.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("base64")

const keys = generateKeyPairSync("ed25519")
const other = generateKeyPairSync("ed25519")
const PUBLIC_KEY_B64 = rawPublicKeyB64(keys.publicKey)
const publicKey = parseHubPublicKey(PUBLIC_KEY_B64) as KeyObject

const body = Buffer.from(
  '{"event":"Transactions","transaction":{"id":"877be576","transactionTypeId":9}}',
)

const signature = (
  privateKey: KeyObject,
  { id = ID, timestamp = String(NOW), raw = body } = {},
) =>
  `v1a,${sign(null, Buffer.concat([Buffer.from(`${id}.${timestamp}.`), raw]), privateKey).toString("base64")}`

const check = (overrides: Partial<Parameters<typeof checkHubSignature>[0]> = {}) =>
  checkHubSignature({
    webhookId: ID,
    timestamp: String(NOW),
    signatureHeader: signature(keys.privateKey),
    rawBody: body,
    publicKey,
    nowSeconds: NOW,
    ...overrides,
  })

describe("checkHubSignature", () => {
  it("accepts a delivery signed by the webhook's key", () => {
    expect(check()).toEqual({ ok: true })
  })

  it("rejects a body changed after signing", () => {
    expect(check({ rawBody: Buffer.from(body.toString().replace("9", "1")) })).toEqual({
      ok: false,
      reason: "bad_signature",
    })
  })

  it("rejects a delivery signed by another key", () => {
    expect(check({ signatureHeader: signature(other.privateKey) })).toEqual({
      ok: false,
      reason: "bad_signature",
    })
  })

  it("rejects a signature moved to another webhook-id", () => {
    expect(check({ webhookId: "msg_other" })).toEqual({
      ok: false,
      reason: "bad_signature",
    })
  })

  it("rejects a timestamp outside the five minute window, either way", () => {
    const late = String(NOW - HUB_SIGNATURE_TOLERANCE_SECONDS - 1)
    const early = String(NOW + HUB_SIGNATURE_TOLERANCE_SECONDS + 1)
    for (const timestamp of [late, early]) {
      expect(
        check({ timestamp, signatureHeader: signature(keys.privateKey, { timestamp }) }),
      ).toEqual({ ok: false, reason: "stale_timestamp" })
    }
  })

  it("accepts a timestamp at the edge of the window", () => {
    const timestamp = String(NOW - HUB_SIGNATURE_TOLERANCE_SECONDS)
    expect(
      check({ timestamp, signatureHeader: signature(keys.privateKey, { timestamp }) }),
    ).toEqual({ ok: true })
  })

  it("rejects a timestamp that is not whole seconds", () => {
    expect(check({ timestamp: "1795184000.5" })).toEqual({
      ok: false,
      reason: "bad_timestamp",
    })
  })

  it.each([
    ["webhook-id", { webhookId: undefined }],
    ["webhook-timestamp", { timestamp: undefined }],
    ["webhook-signature", { signatureHeader: undefined }],
  ])("rejects a delivery without %s", (_header, overrides) => {
    expect(check(overrides)).toEqual({ ok: false, reason: "missing_headers" })
  })

  it("rejects a signature header with no v1a entry", () => {
    const v1 = signature(keys.privateKey).replace("v1a,", "v1,")
    expect(check({ signatureHeader: v1 })).toEqual({ ok: false, reason: "no_signature" })
  })

  it("accepts any valid v1a entry among several", () => {
    const header = `${signature(other.privateKey)} ${signature(keys.privateKey)}`
    expect(check({ signatureHeader: header })).toEqual({ ok: true })
  })
})

describe("parseHubPublicKey", () => {
  it("reads the raw 32-byte key in base64", () => {
    expect(parseHubPublicKey(PUBLIC_KEY_B64)).toBeDefined()
  })

  it.each([
    ["empty", ""],
    ["too short", Buffer.alloc(31).toString("base64")],
    ["a PEM key", "-----BEGIN PUBLIC KEY-----"],
  ])("refuses a key that is %s", (_label, value) => {
    expect(parseHubPublicKey(value)).toBeUndefined()
  })
})

describe("verifyIbexHubSignature", () => {
  const load = (publicKeyB64: string) => {
    mockHub.publicKey = publicKeyB64
    let middleware: (req: never, res: never, next: () => void) => void = () => undefined
    jest.isolateModules(() => {
      middleware = jest.requireActual<Module>(
        "@services/ibex/webhook-server/middleware/verify-hub-signature",
      ).verifyIbexHubSignature as never
    })
    return middleware
  }

  const response = () => {
    const res = { status: jest.fn(), end: jest.fn() }
    res.status.mockReturnValue(res)
    return res
  }

  const request = (headers: Record<string, string>, raw: Buffer = body) => ({
    path: "/hub/transactions",
    body: raw,
    header: (name: string) => headers[name],
  })

  const signedHeaders = () => ({
    "webhook-id": ID,
    "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
  })

  it("answers 503 to every delivery while no key is configured", () => {
    const middleware = load("")
    const res = response()
    const next = jest.fn()

    middleware(request({}) as never, res as never, next)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(next).not.toHaveBeenCalled()
  })

  it("parses the body and passes a signed delivery on", () => {
    const middleware = load(PUBLIC_KEY_B64)
    const headers = signedHeaders()
    const req = request({
      ...headers,
      "webhook-signature": signature(keys.privateKey, {
        timestamp: headers["webhook-timestamp"],
      }),
    })
    const next = jest.fn()

    middleware(req as never, response() as never, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(req.body).toEqual({
      event: "Transactions",
      transaction: { id: "877be576", transactionTypeId: 9 },
    })
  })

  it("answers 401 to a forged delivery", () => {
    const middleware = load(PUBLIC_KEY_B64)
    const headers = signedHeaders()
    const res = response()
    const next = jest.fn()

    middleware(
      request({
        ...headers,
        "webhook-signature": signature(other.privateKey, {
          timestamp: headers["webhook-timestamp"],
        }),
      }) as never,
      res as never,
      next,
    )

    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it("answers 400 to a signed body that is not JSON", () => {
    const middleware = load(PUBLIC_KEY_B64)
    const headers = signedHeaders()
    const raw = Buffer.from("not json")
    const res = response()
    const next = jest.fn()

    middleware(
      request(
        {
          ...headers,
          "webhook-signature": signature(keys.privateKey, {
            timestamp: headers["webhook-timestamp"],
            raw,
          }),
        },
        raw,
      ) as never,
      res as never,
      next,
    )

    expect(res.status).toHaveBeenCalledWith(400)
    expect(next).not.toHaveBeenCalled()
  })
})
