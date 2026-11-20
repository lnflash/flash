import { AddressInfo } from "net"
import { Server } from "http"
import { generateKeyPairSync, sign } from "crypto"

import express from "express"

// The IBEX Hub route over real HTTP (ENG-891): the signature covers the exact
// bytes IBEX sent, so this checks the route reads the raw body even with the
// server's JSON parser mounted after it, and that only a signed crypto receive
// reaches the recorder.

const keys = generateKeyPairSync("ed25519")
const other = generateKeyPairSync("ed25519")
const rawKey = (key: typeof keys.publicKey) =>
  (key.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("base64")

const mockRecordSignal = jest.fn()
const mockHubConfig = { publicKey: rawKey(keys.publicKey), allowedIps: [] as string[] }

jest.mock("@config", () => ({
  IbexConfig: {
    webhook: {
      uri: "https://ibex.example.com",
      allowedIps: [],
      get hub() {
        return mockHubConfig
      },
    },
  },
}))
jest.mock("@app/bridge/match-ibex-deposits", () => ({
  IBEX_CRYPTO_RECEIVE_TYPE_ID: 9,
  recordIbexCreditSignal: (...args: unknown[]) => mockRecordSignal(...args),
}))
jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

let server: Server
let url: string

beforeAll(async () => {
  // Required here, not imported: the route reads the key from config when it
  // loads, and the key pair above only exists once this file has run.
  const { router } = jest.requireActual<
    typeof import("@services/ibex/webhook-server/routes/hub-transactions")
  >("@services/ibex/webhook-server/routes/hub-transactions")
  const app = express()
  app.set("trust proxy", 1)
  app.use(router)
  app.use(express.json())
  server = app.listen(0)
  await new Promise((resolve) => server.once("listening", resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hub/transactions`
})

afterAll(() => new Promise((resolve) => server.close(resolve)))

beforeEach(() => {
  jest.clearAllMocks()
  mockRecordSignal.mockResolvedValue("recorded")
})

// Formatted the way a sender might, spaces and all: re-serializing the parsed
// JSON would not reproduce these bytes.
const BODY =
  '{ "event": "Transactions",\n  "transaction": { "id": "877be576", "transactionTypeId": 9, "status": "completed" } }'

const deliver = async (signer = keys.privateKey, body = BODY, target = url) => {
  const id = "msg_0b5e2a51"
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = sign(null, Buffer.from(`${id}.${timestamp}.${body}`), signer)
  return fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1a,${signature.toString("base64")}`,
    },
    body,
  })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe("POST /hub/transactions", () => {
  it("accepts a signed delivery and hands the crypto receive on", async () => {
    const res = await deliver()
    await settle()

    expect(res.status).toBe(200)
    expect(mockRecordSignal).toHaveBeenCalledWith({
      ibexTransactionId: "877be576",
      webhookId: "msg_0b5e2a51",
    })
  })

  it("refuses a delivery signed by another key", async () => {
    const res = await deliver(other.privateKey)
    await settle()

    expect(res.status).toBe(401)
    expect(mockRecordSignal).not.toHaveBeenCalled()
  })

  it("refuses an unsigned delivery", async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: BODY,
    })
    await settle()

    expect(res.status).toBe(401)
    expect(mockRecordSignal).not.toHaveBeenCalled()
  })

  it("answers 200 to a signed Lightning transaction and records nothing", async () => {
    const res = await deliver(
      keys.privateKey,
      '{"event":"Transactions","transaction":{"id":"ln-1","transactionTypeId":1}}',
    )
    await settle()

    expect(res.status).toBe(200)
    expect(mockRecordSignal).not.toHaveBeenCalled()
  })
})

describe("POST /hub/transactions with the hub IP allowlist set", () => {
  let listedServer: Server
  let listedUrl: string

  beforeAll(async () => {
    // A fresh copy of the route and its middleware, loaded with the hub list
    // set: both parse the config once, when they load.
    mockHubConfig.allowedIps = ["203.0.113.4"]
    let router: express.Router | undefined
    jest.isolateModules(() => {
      router = jest.requireActual<
        typeof import("@services/ibex/webhook-server/routes/hub-transactions")
      >("@services/ibex/webhook-server/routes/hub-transactions").router
    })
    mockHubConfig.allowedIps = []
    const app = express()
    app.set("trust proxy", 1)
    app.use(router as express.Router)
    app.use(express.json())
    listedServer = app.listen(0)
    await new Promise((resolve) => listedServer.once("listening", resolve))
    listedUrl = `http://127.0.0.1:${(listedServer.address() as AddressInfo).port}/hub/transactions`
  })

  afterAll(() => new Promise((resolve) => listedServer.close(resolve)))

  it("refuses a signed delivery from an unlisted address with 403", async () => {
    const res = await deliver(keys.privateKey, BODY, listedUrl)
    await settle()

    expect(res.status).toBe(403)
    expect(mockRecordSignal).not.toHaveBeenCalled()
  })
})
