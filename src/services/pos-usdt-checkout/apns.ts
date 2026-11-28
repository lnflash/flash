import { createPrivateKey, KeyObject, sign } from "crypto"
import { readFileSync, statSync } from "fs"
import { connect as http2Connect } from "http2"

import {
  APNS_EXPIRATION_S,
  LivePush,
  livePayload,
  PUSH_TOKEN,
  PushResult,
  Transport,
} from "@app/pos-usdt-checkout/live-updates"

/**
 * Token-based (ES256) ActivityKit pushes to the APNs *sandbox* only. There is
 * no production host in this module: sending to production devices needs a
 * reviewed code change, not a configuration flip.
 *
 * Logs and errors carry only APNs's reason word (e.g. "BadDeviceToken"),
 * never a device token, provider token, key or body.
 */

export const APNS_SANDBOX = "https://api.sandbox.push.apple.com"
const TEAM_OR_KEY = /^[A-Z0-9]{10}$/
// "<bundle id>.push-type.liveactivity"
const TOPIC = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\.push-type\.liveactivity$/
const REASON = /^[A-Za-z]{1,64}$/
const TIMEOUT_MS = 15_000
// Apple refuses provider tokens refreshed more than once per 20 minutes and
// older than an hour.
const PROVIDER_TOKEN_TTL_S = 40 * 60

export class ApnsConfigError extends Error {}

export type ApnsCredential = { teamId: string; keyId: string; key: KeyObject }

/** Reads the .p8 signing key from a file that "other" users cannot read. */
export function loadApnsCredential(
  teamId: string,
  keyId: string,
  keyFile: string,
): ApnsCredential {
  if (!TEAM_OR_KEY.test(teamId) || !TEAM_OR_KEY.test(keyId))
    throw new ApnsConfigError(
      "APNs team id and key id are 10 uppercase letters or digits.",
    )
  const stat = statSync(keyFile)
  if (!stat.isFile() || stat.mode & 0o007)
    throw new ApnsConfigError("APNs key file must not be readable by other users.")
  let key: KeyObject
  try {
    key = createPrivateKey(readFileSync(keyFile, "utf8"))
  } catch {
    throw new ApnsConfigError("APNs key file is not a PEM private key.")
  }
  if (
    key.asymmetricKeyType !== "ec" ||
    key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  )
    throw new ApnsConfigError("APNs key must be a P-256 (ES256) key.")
  return { teamId, keyId, key }
}

export function checkTopic(topic: string) {
  if (!TOPIC.test(topic))
    throw new ApnsConfigError("APNs topic must be '<bundle id>.push-type.liveactivity'.")
  return topic
}

/** How the outbox treats one APNs answer. */
export function classifyApns(
  status: number | undefined,
  rawReason: unknown,
  retryAfter?: unknown,
): PushResult {
  const reason =
    typeof rawReason === "string" && REASON.test(rawReason) ? rawReason : "unknown"
  if (status === 200) return { kind: "ok" }
  if (status === 410) return { kind: "gone", reason }
  if (
    status === 400 &&
    (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic")
  )
    return { kind: "gone", reason }
  if (status === 403) return { kind: "auth", reason }
  if (status === 429 || status === 500 || status === 503 || status === undefined) {
    const seconds = typeof retryAfter === "string" ? Number(retryAfter) : NaN
    return Number.isFinite(seconds) && seconds > 0
      ? { kind: "retry", reason, retryAfterMs: seconds * 1000 }
      : { kind: "retry", reason }
  }
  if (status >= 400 && status < 500) return { kind: "refused", reason }
  return { kind: "retry", reason }
}

const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url")

export function providerToken(credential: ApnsCredential, issuedAt: number) {
  const unsigned =
    encode({ alg: "ES256", kid: credential.keyId }) +
    "." +
    encode({ iss: credential.teamId, iat: issuedAt })
  const signature = sign("sha256", Buffer.from(unsigned), {
    key: credential.key,
    dsaEncoding: "ieee-p1363",
  })
  return unsigned + "." + signature.toString("base64url")
}

// The slice of an http2 session this transport uses; tests supply their own.
export type Http2Like = {
  request(headers: Record<string, string>): StreamLike
  on(event: "error" | "goaway" | "close", listener: () => void): unknown
  close(): void
  destroyed?: boolean
}
export type StreamLike = {
  on(
    event: "response",
    l: (h: Record<string, string | number | undefined>) => void,
  ): unknown
  on(event: "data", l: (chunk: string) => void): unknown
  on(event: "end" | "close", l: () => void): unknown
  on(event: "error", l: (e: unknown) => void): unknown
  setEncoding(e: "utf8"): unknown
  setTimeout(ms: number, l: () => void): unknown
  close(): void
  end(body: string): void
}

export type ApnsOptions = {
  credential: ApnsCredential
  topic: string
  connect?: (authority: string) => Http2Like
  nowSeconds?: () => number
}

export function apnsTransport(o: ApnsOptions): Transport & { close(): void } {
  const topic = checkTopic(o.topic)
  const nowSeconds = o.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  const connect =
    o.connect ?? ((authority: string) => http2Connect(authority) as unknown as Http2Like)
  let session: Http2Like | undefined
  let cached: { token: string; at: number } | undefined

  const bearer = () => {
    const now = nowSeconds()
    if (!cached || now - cached.at >= PROVIDER_TOKEN_TTL_S)
      cached = { token: providerToken(o.credential, now), at: now }
    return cached.token
  }

  const open = () => {
    if (session && !session.destroyed) return session
    const s = connect(APNS_SANDBOX)
    const drop = () => {
      if (session === s) session = undefined
    }
    s.on("error", drop)
    s.on("goaway", drop)
    s.on("close", drop)
    session = s
    return s
  }

  function post(token: string, push: LivePush): Promise<PushResult> {
    const headers = {
      ":method": "POST",
      ":path": "/3/device/" + token,
      "apns-topic": topic,
      "apns-push-type": "liveactivity",
      "apns-priority": "10",
      "apns-expiration": String(nowSeconds() + APNS_EXPIRATION_S),
      "authorization": "bearer " + bearer(),
    }
    return new Promise((resolve) => {
      let settled = false
      const done = (r: PushResult) => {
        if (!settled) {
          settled = true
          resolve(r)
        }
      }
      let stream: StreamLike
      try {
        stream = open().request(headers)
      } catch {
        session = undefined
        return done({ kind: "retry", reason: "connect" })
      }
      let status: number | undefined
      let retryAfter: unknown
      let body = ""
      stream.setEncoding("utf8")
      stream.setTimeout(TIMEOUT_MS, () => {
        done({ kind: "retry", reason: "timeout" })
        stream.close()
      })
      stream.on("response", (h) => {
        status = Number(h[":status"])
        retryAfter = h["retry-after"]
      })
      stream.on("data", (chunk) => {
        if (body.length < 4096) body += chunk
      })
      stream.on("error", () => done({ kind: "retry", reason: "stream" }))
      stream.on("end", () => {
        let reason: unknown
        try {
          reason = body ? JSON.parse(body).reason : undefined
        } catch {
          reason = undefined
        }
        const result = classifyApns(status, reason, retryAfter)
        // Apple asks for a fresh provider token.
        if (result.kind === "auth" && reason === "ExpiredProviderToken")
          cached = undefined
        done(result)
      })
      stream.on("close", () => done({ kind: "retry", reason: "closed" }))
      stream.end(JSON.stringify(livePayload(push)))
    })
  }

  return {
    async send(token, push) {
      // Never put anything but a well-formed hex token into the request path.
      if (!PUSH_TOKEN.test(token)) return { kind: "gone", reason: "MalformedToken" }
      return post(token, push)
    },
    close() {
      session?.close()
      session = undefined
    },
  }
}
