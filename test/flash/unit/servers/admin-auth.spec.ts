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
import {
  parseAuthHeader,
  startAdminSchemaIfConfigured,
  startAdminServer,
} from "@servers/graphql-admin-server"
import { baseLogger } from "@services/logger"
import { MIN_SECRET_LENGTH, WeakSecretError } from "@utils/weak-secrets"

import {
  clearDevUnsafeModeFlags,
  restoreDevUnsafeModeFlags,
} from "test/flash/helpers/dev-context-env"

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
    // published in this repo means anyone can forge admin JWTs. This one is
    // refused by the length floor — it is 13 chars.
    expect("not-so-secret".length).toBeLessThan(MIN_SECRET_LENGTH)
    await expect(startWith("not-so-secret")).rejects.toThrow(WeakSecretError)
    await expect(startWith("not-so-secret")).rejects.toThrow(/ERPNEXT_JWT_SECRET/)
  })

  // The case no length floor can catch: 64 random-looking hex chars, committed
  // to this repo's .env. A deployment that ships the repo default is as open as
  // one running "change-me".
  it("refuses to start on the committed dev-only secret outside a dev context", async () => {
    const savedNetwork = process.env.NETWORK
    const committed = "0a1cb6ba85cda40291e3ca4f2a777041cc59b48ba9fac2488e0bf752340c4588"
    try {
      expect(committed.length).toBeGreaterThanOrEqual(MIN_SECRET_LENGTH)
      process.env.NETWORK = "mainnet"
      clearDevUnsafeModeFlags()
      await expect(startWith(committed)).rejects.toThrow(WeakSecretError)
    } finally {
      if (savedNetwork === undefined) delete process.env.NETWORK
      else process.env.NETWORK = savedNetwork
      restoreDevUnsafeModeFlags()
    }
  })

  it("refuses to start when the secret is unset or too short", async () => {
    await expect(startWith(undefined)).rejects.toThrow(WeakSecretError)
    await expect(startWith("x")).rejects.toThrow(WeakSecretError)
  })
})

// In the api process both server starts carry exitOnBootFailure (@servers/boot),
// so a throw out of the admin start kills the PUBLIC GraphQL API too. An
// environment with no ERP integration — a fresh staging namespace, a bare
// `docker compose up` of the api — never sets ERPNEXT_JWT_SECRET at all, and
// must not go from "admin API rejects every token" to CrashLoopBackOff on the
// payments API.
describe("admin schema mount in the api process", () => {
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    warnSpy = jest.spyOn(baseLogger, "warn").mockImplementation(() => baseLogger)
  })

  afterEach(() => {
    warnSpy.mockRestore()
    mockAdminConfig.ERPNEXT_JWT_SECRET = STRONG_SECRET
  })

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["blank", "   "],
  ])("skips the mount and stays alive when the secret is %s", async (_label, secret) => {
    mockAdminConfig.ERPNEXT_JWT_SECRET = secret as string

    await expect(startAdminSchemaIfConfigured()).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain("ERPNEXT_JWT_SECRET")
  })

  // "Configured badly" is not "not configured": a value that IS set still has
  // to clear the floor, and failing that is still fatal.
  it("still fails hard when the secret is set but weak", async () => {
    mockAdminConfig.ERPNEXT_JWT_SECRET = "x"

    await expect(startAdminSchemaIfConfigured()).rejects.toThrow(WeakSecretError)
  })
})
