import { generateKeyPairSync, KeyObject, verify } from "crypto"
import { EventEmitter } from "events"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { pushFor } from "@app/pos-usdt-checkout/live-updates"
import {
  APNS_SANDBOX,
  apnsTransport,
  classifyApns,
  Http2Like,
  loadApnsCredential,
  StreamLike,
} from "@services/pos-usdt-checkout/apns"

// A throwaway key generated per run: no real credential is used anywhere.
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
const credential = { teamId: "TEAM000000", keyId: "KEY0000000", key: privateKey }
const TOPIC = "com.flash.pos.preview.push-type.liveactivity"
const TOKEN = "0f".repeat(32)
const NOW = 1_800_000_000

type Reply = {
  status?: number
  body?: string
  headers?: Record<string, string>
  hang?: boolean
}

// A synthetic APNs: records each request, answers from a script.
function fakeApns(replies: Reply[]) {
  const requests: { authority: string; headers: Record<string, string>; body: string }[] =
    []
  const timeouts: Array<() => void> = []
  let connects = 0
  const connect = (authority: string): Http2Like => {
    connects++
    const session = new EventEmitter() as EventEmitter & Http2Like
    session.close = () => session.emit("close")
    session.request = (headers) => {
      const stream = new EventEmitter() as EventEmitter & StreamLike
      stream.setEncoding = () => stream
      stream.setTimeout = (_ms: number, l: () => void) => timeouts.push(l)
      stream.close = () => stream.emit("close")
      stream.end = (body: string) => {
        requests.push({ authority, headers, body })
        const reply = replies.shift() ?? { status: 200 }
        if (reply.hang) return
        setImmediate(() => {
          stream.emit("response", { ":status": reply.status, ...reply.headers })
          if (reply.body) stream.emit("data", reply.body)
          stream.emit("end")
          stream.emit("close")
        })
      }
      return stream
    }
    return session
  }
  return { connect, requests, timeouts, connects: () => connects }
}

const verifyJwt = (jwt: string, key: KeyObject) => {
  const [header, claims, signature] = jwt.split(".")
  const ok = verify(
    "sha256",
    Buffer.from(header + "." + claims),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  )
  return {
    ok,
    header: JSON.parse(Buffer.from(header, "base64url").toString()),
    claims: JSON.parse(Buffer.from(claims, "base64url").toString()),
  }
}

describe("APNs sandbox transport", () => {
  it("posts a signed liveactivity push to the sandbox host only", async () => {
    const apns = fakeApns([{ status: 200 }])
    const transport = apnsTransport({
      credential,
      topic: TOPIC,
      connect: apns.connect,
      nowSeconds: () => NOW,
    })
    expect(await transport.send(TOKEN, pushFor(3, NOW))).toEqual({ kind: "ok" })
    const [req] = apns.requests
    expect(req.authority).toBe("https://api.sandbox.push.apple.com")
    expect(APNS_SANDBOX).not.toMatch(/api\.push\.apple\.com/)
    expect(req.headers).toMatchObject({
      ":method": "POST",
      ":path": "/3/device/" + TOKEN,
      "apns-topic": TOPIC,
      "apns-push-type": "liveactivity",
      "apns-priority": "10",
      "apns-expiration": String(NOW + 180),
    })
    expect(JSON.parse(req.body)).toEqual({
      aps: {
        "timestamp": NOW,
        "event": "end",
        "content-state": { stage: 1, cents: 0, folded: false, singleStroke: false },
        "dismissal-date": NOW + 300,
      },
    })
    const jwt = verifyJwt(req.headers.authorization.replace(/^bearer /, ""), publicKey)
    expect(jwt).toEqual({
      ok: true,
      header: { alg: "ES256", kid: "KEY0000000" },
      claims: { iss: "TEAM000000", iat: NOW },
    })
    // The device token is in the path and nowhere else.
    expect(req.body).not.toContain(TOKEN)
    transport.close()
  })

  it("reuses one connection and one provider token, refreshing it when Apple asks", async () => {
    let now = NOW
    const apns = fakeApns([
      { status: 200 },
      { status: 403, body: JSON.stringify({ reason: "ExpiredProviderToken" }) },
      { status: 200 },
    ])
    const transport = apnsTransport({
      credential,
      topic: TOPIC,
      connect: apns.connect,
      nowSeconds: () => now,
    })
    await transport.send(TOKEN, pushFor(0, now))
    now += 60
    expect(await transport.send(TOKEN, pushFor(1, now))).toEqual({
      kind: "auth",
      reason: "ExpiredProviderToken",
    })
    now += 1
    await transport.send(TOKEN, pushFor(1, now))
    const iat = apns.requests.map(
      (r) => verifyJwt(r.headers.authorization.slice(7), publicKey).claims.iat,
    )
    expect(iat).toEqual([NOW, NOW, NOW + 61])
    expect(apns.connects()).toBe(1)
  })

  it("treats a hung request as a retry", async () => {
    const apns = fakeApns([{ hang: true }])
    const transport = apnsTransport({ credential, topic: TOPIC, connect: apns.connect })
    const pending = transport.send(TOKEN, pushFor(0, NOW))
    await new Promise((r) => setImmediate(r))
    apns.timeouts[0]()
    expect(await pending).toEqual({ kind: "retry", reason: "timeout" })
  })

  it("never puts a malformed token on the wire", async () => {
    const apns = fakeApns([])
    const transport = apnsTransport({ credential, topic: TOPIC, connect: apns.connect })
    for (const bad of ["../../3/device/x", TOKEN.toUpperCase(), "ab"])
      expect((await transport.send(bad, pushFor(0, NOW))).kind).toBe("gone")
    expect(apns.connects()).toBe(0)
  })

  it("refuses a topic that is not a liveactivity topic", () => {
    expect(() => apnsTransport({ credential, topic: "com.flash.pos.preview" })).toThrow(
      /push-type\.liveactivity/,
    )
  })
})

describe("APNs answers", () => {
  it.each([
    [200, undefined, "ok"],
    [410, "Unregistered", "gone"],
    [400, "BadDeviceToken", "gone"],
    [400, "DeviceTokenNotForTopic", "gone"],
    [403, "InvalidProviderToken", "auth"],
    [403, "BadCertificateEnvironment", "auth"],
    [429, "TooManyRequests", "retry"],
    [500, "InternalServerError", "retry"],
    [503, "ServiceUnavailable", "retry"],
    [undefined, undefined, "retry"],
    [400, "BadPriority", "refused"],
    [413, "PayloadTooLarge", "refused"],
  ])("%p %p is %p", (status, reason, kind) => {
    expect(classifyApns(status, reason).kind).toBe(kind)
  })

  it("keeps only a plain reason word and Apple's retry-after", () => {
    expect(classifyApns(400, "Bad <token " + TOKEN + ">")).toEqual({
      kind: "refused",
      reason: "unknown",
    })
    expect(classifyApns(429, "TooManyRequests", "7")).toEqual({
      kind: "retry",
      reason: "TooManyRequests",
      retryAfterMs: 7_000,
    })
  })
})

describe("the APNs signing key", () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pos-usdt-apns-"))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("loads a P-256 key from a file other users cannot read", () => {
    const file = join(dir, "AuthKey_TEST.p8")
    writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }))
    chmodSync(file, 0o600)
    expect(loadApnsCredential("TEAM000000", "KEY0000000", file).keyId).toBe("KEY0000000")
    chmodSync(file, 0o604)
    expect(() => loadApnsCredential("TEAM000000", "KEY0000000", file)).toThrow(
      /other users/,
    )
  })

  it("refuses an RSA key and malformed ids", () => {
    const file = join(dir, "rsa.pem")
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    writeFileSync(file, rsa.export({ type: "pkcs8", format: "pem" }))
    chmodSync(file, 0o600)
    expect(() => loadApnsCredential("TEAM000000", "KEY0000000", file)).toThrow(/P-256/)
    expect(() => loadApnsCredential("team", "KEY0000000", file)).toThrow(/10 uppercase/)
  })
})
