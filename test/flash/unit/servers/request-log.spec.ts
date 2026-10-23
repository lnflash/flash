import { createServer, request as httpRequest } from "http"

import express from "express"
import pino from "pino"

import { createRequestLogger } from "@servers/request-log"

const secret = "fixture-private-token-and-personal-data"
const payload = {
  query: `mutation ${secret.replaceAll("-", "_")} { privateField } # ${secret}`,
  variables: {
    input: {
      code: secret,
      authToken: secret,
      bankAccountNumber: secret,
      selfieUrl: secret,
    },
  },
}

const exercise = async (
  path: string,
  rawBody = JSON.stringify(payload),
  status = 200,
  requestID?: string,
) => {
  const records: string[] = []
  const logger = pino(
    { base: null, timestamp: false },
    { write: (value: string) => records.push(value) },
  )
  const app = express()
  if (requestID)
    app.use((req, _res, next) => {
      req.id = requestID
      next()
    })
  app.use(createRequestLogger(logger))
  app.use(express.json())
  let observed: unknown
  app.use((req, res) => {
    // Source customProps previously copied all of this after body parsing.
    Object.assign(req, {
      gqlContext: { user: { phone: secret, deviceTokens: [secret] } },
      token: { sub: secret },
    })
    observed = req.body
    if (status >= 500) {
      Object.assign(res, {
        err: Object.assign(new Error(secret), {
          config: { headers: { Authorization: secret }, data: payload },
          response: { data: secret },
        }),
      })
    }
    res.status(status).json({ ok: status < 400 })
  })
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      // Express identifies error handlers by their four declared parameters.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction,
    ) => {
      Object.assign(res, { err: error })
      res.status(400).json({ error: "invalid request" })
    },
  )
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing fixture port")
    const responseStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path,
          method: "POST",
          agent: false,
          headers: {
            "content-type": "application/json",
            "authorization": `Bearer ${secret}`,
            "appcheck": secret,
            "cookie": `session=${secret}`,
            "x-api-key": secret,
            "content-length": Buffer.byteLength(rawBody),
          },
        },
        (response) => {
          response.resume()
          response.on("error", reject)
          response.on("end", () => resolve(response.statusCode ?? 0))
        },
      )
      request.on("error", reject)
      request.end(rawBody)
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    return {
      records: records.map((line) => JSON.parse(line)),
      raw: records.join(""),
      responseStatus,
      observed,
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

it("logs status and fixed route after parsing without credentials, body, query values or context", async () => {
  const result = await exercise(
    `/graphql?authToken=${secret}&variables=${encodeURIComponent(JSON.stringify(payload))}`,
  )
  expect(result.responseStatus).toBe(200)
  expect(result.observed).toEqual(payload)
  expect(result.records).toHaveLength(1)
  expect(result.records[0]).toMatchObject({
    req: { method: "POST", url: "/graphql" },
    res: { statusCode: 200 },
    msg: "request completed",
  })
  expect(result.raw).not.toContain(secret)
  expect(result.records[0]).not.toHaveProperty("body")
  expect(result.records[0]).not.toHaveProperty("gqlContext.user")
  expect(result.records[0].req).not.toHaveProperty("headers")
})

it.each(["/consent", "/consent/", "/consent/log", "/consent-status", `/${secret}`])(
  "never captures parsed consent/unknown-route body on %s",
  async (path) => {
    const result = await exercise(path)
    expect(result.responseStatus).toBe(200)
    expect(result.observed).toEqual(payload)
    expect(result.records).toHaveLength(1)
    expect(result.raw).not.toContain(secret)
    expect(result.records[0].req.url).toBe(
      path === "/consent" || path === "/consent/log" ? path : "[other route]",
    )
  },
)

it("does not serialize Axios-like error payloads or stacks on failure", async () => {
  const result = await exercise("/graphql", JSON.stringify(payload), 500)
  expect(result.responseStatus).toBe(500)
  expect(result.observed).toEqual(payload)
  expect(result.records[0]).toMatchObject({
    err: { type: "HttpRequestError" },
    res: { statusCode: 500 },
    msg: "request errored",
  })
  expect(result.raw).not.toContain(secret)
  expect(result.records[0].err).not.toHaveProperty("stack")
})

it("never serializes malformed JSON retained by body-parser errors", async () => {
  const result = await exercise("/graphql", `{"private":"${secret}" invalid`)
  expect(result.responseStatus).toBe(400)
  expect(result.records).toHaveLength(1)
  expect(result.raw).not.toContain(secret)
})

it("does not trust an arbitrary preassigned request identifier", async () => {
  const requestID = "fixture-private-request-identifier"
  const result = await exercise("/graphql", JSON.stringify(payload), 200, requestID)
  expect(result.responseStatus).toBe(200)
  expect(result.records).toHaveLength(1)
  expect(result.records[0].req).not.toHaveProperty("id")
  expect(result.raw).not.toContain(requestID)
})
