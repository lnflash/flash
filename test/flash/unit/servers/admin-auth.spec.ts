// A strong, test-only secret: the boot guard refuses anything short or
// known-public, so the happy-path cases need a realistic one. The factory is
// hoisted above every const in this file, hence the inline literal.
jest.mock("@config", () => ({
  ...jest.requireActual("@config"),
  ADMIN_CONFIG: {
    ERPNEXT_JWT_SECRET:
      "d3f9a1c85b2e47ad9c06f1b8e5427ac31f0d6b9e84c27a5f0b93e1d6c48a7b02",
    GALOY_ADMIN_PORT: 4001,
  },
}))

// The admin server's import graph reaches ioredis (via @services/mongodb ->
// mongoose -> ibex client -> cache), and ioredis dials on construction — which
// leaves a live handle behind and hangs an in-band jest run of this file. None
// of it is needed to verify JWT parsing or the boot guard.
jest.mock("@services/redis", () => {
  const noop = {
    on: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    quit: jest.fn(),
    disconnect: jest.fn(),
  }
  return {
    redis: noop,
    redisSub: noop,
    redisPubSub: { asyncIterator: jest.fn(), publish: jest.fn() },
    redisCache: { get: jest.fn(), set: jest.fn(), clear: jest.fn() },
    disconnectAll: jest.fn(),
  }
})

import crypto from "crypto"

import jwt from "jsonwebtoken"

import { AuthenticationError } from "@graphql/error"
import { parseAuthHeader, startAdminServer } from "@servers/graphql-admin-server"
import { WeakSecretError } from "@utils/weak-secrets"

// The live object the server reads its secret from, so a test can swap it.
const mockAdminConfig = jest.requireMock("@config").ADMIN_CONFIG as {
  ERPNEXT_JWT_SECRET: string
}
const STRONG_SECRET = mockAdminConfig.ERPNEXT_JWT_SECRET

const PAYLOAD = { userId: "admin-1", roles: ["System Manager"] }

// An unsigned token: header {"alg":"none"}, empty signature. The classic
// algorithm-confusion forgery — accepted by any verifier that does not pin.
const noneToken = () => {
  const b64 = (obj: object) => Buffer.from(JSON.stringify(obj)).toString("base64url")
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(PAYLOAD)}.`
}

describe("admin API: JWT verification", () => {
  beforeEach(() => {
    mockAdminConfig.ERPNEXT_JWT_SECRET = STRONG_SECRET
  })

  it("accepts a token signed HS256 with the configured secret", () => {
    const token = jwt.sign(PAYLOAD, STRONG_SECRET, { algorithm: "HS256" })

    const decoded = parseAuthHeader(`Bearer ${token}`)

    expect(decoded.userId).toBe(PAYLOAD.userId)
    expect(decoded.roles).toEqual(PAYLOAD.roles)
  })

  // The explicit pin is what this asserts. jsonwebtoken also narrows to the
  // HMAC family on its own when the key is a string, so the two behavioural
  // cases below pass with or without it — this one fails the moment
  // `algorithms: ["HS256"]` is dropped from the verify call.
  it("pins the verification algorithm to HS256", () => {
    const token = jwt.sign(PAYLOAD, STRONG_SECRET, { algorithm: "HS256" })
    const verifySpy = jest.spyOn(jwt, "verify")

    try {
      parseAuthHeader(`Bearer ${token}`)
      expect(verifySpy).toHaveBeenCalledWith(token, STRONG_SECRET, {
        algorithms: ["HS256"],
      })
    } finally {
      verifySpy.mockRestore()
    }
  })

  it("refuses an `alg: none` token", () => {
    expect(() => parseAuthHeader(`Bearer ${noneToken()}`)).toThrow(AuthenticationError)
  })

  it("refuses an RS256 token, however well-formed", () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
    const token = jwt.sign(PAYLOAD, privateKey.export({ type: "pkcs1", format: "pem" }), {
      algorithm: "RS256",
    })

    expect(() => parseAuthHeader(`Bearer ${token}`)).toThrow(AuthenticationError)
  })

  it("refuses a token signed with a different secret", () => {
    const token = jwt.sign(PAYLOAD, `${STRONG_SECRET}-not-ours`, { algorithm: "HS256" })

    expect(() => parseAuthHeader(`Bearer ${token}`)).toThrow(AuthenticationError)
  })

  it("refuses a missing or malformed authorization header", () => {
    for (const header of [undefined, "", "Basic abc", "Bearer", "Bearer not.a.jwt"]) {
      expect(() => parseAuthHeader(header)).toThrow(AuthenticationError)
    }
  })
})

describe("admin API: boot guard", () => {
  const startWith = (secret: string | undefined) => {
    mockAdminConfig.ERPNEXT_JWT_SECRET = secret as string
    return startAdminServer({
      // The guard is the first statement in the function — nothing below it
      // (express, apollo, the port) is reached on the refusal path.
      schema: {} as never,
      port: 0,
      type: "admin",
    })
  }

  afterEach(() => {
    mockAdminConfig.ERPNEXT_JWT_SECRET = STRONG_SECRET
  })

  it("refuses to start on the repo's placeholder secret", async () => {
    // The admin API's only auth is this HMAC secret; booting with a value
    // published in this repo means anyone can forge admin JWTs.
    await expect(startWith("not-so-secret")).rejects.toThrow(WeakSecretError)
    await expect(startWith("not-so-secret")).rejects.toThrow(/ERPNEXT_JWT_SECRET/)
  })

  it("refuses to start when the secret is unset or too short", async () => {
    await expect(startWith(undefined)).rejects.toThrow(WeakSecretError)
    await expect(startWith("x")).rejects.toThrow(WeakSecretError)
  })
})
