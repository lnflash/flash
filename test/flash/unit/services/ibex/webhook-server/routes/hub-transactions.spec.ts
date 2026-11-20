// IBEX Hub's organization webhook, event "Transactions" (ENG-891). It reports
// every transaction on every account; only crypto receives are acted on, and
// IBEX gets its 200 before any of that work.

const mockRecordSignal = jest.fn()

jest.mock("@services/ibex/webhook-server/middleware", () => ({
  validateIbexHubIp: jest.fn((_req, _res, next) => next()),
  verifyIbexHubSignature: jest.fn((_req, _res, next) => next()),
}))
jest.mock("@app/bridge/match-ibex-deposits", () => ({
  recordIbexCreditSignal: (...args: unknown[]) => mockRecordSignal(...args),
}))
jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import {
  validateIbexHubIp,
  verifyIbexHubSignature,
} from "@services/ibex/webhook-server/middleware"
import {
  hubTransactionsHandler,
  paths,
  router,
} from "@services/ibex/webhook-server/routes/hub-transactions"

const response = () => {
  const order: string[] = []
  const res = {
    order,
    status: jest.fn((code: number) => {
      order.push(`status ${code}`)
      return res
    }),
    json: jest.fn(() => res),
  }
  return res
}

const request = (body: unknown) => ({
  body,
  header: (name: string) => (name === "webhook-id" ? "msg_1" : undefined),
})

const flush = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
  jest.clearAllMocks()
  mockRecordSignal.mockResolvedValue("recorded")
})

describe("IBEX Hub transactions route", () => {
  it("is served at /hub/transactions behind the rate limit, the hub IP check and the signature check", () => {
    expect(paths.transactions).toBe("/hub/transactions")

    const layer = (
      router.stack as Array<{
        route?: { path: string; stack: Array<{ handle: unknown }> }
      }>
    ).find((l) => l.route?.path === paths.transactions)
    expect(layer).toBeDefined()
    const handles = layer!.route!.stack.map((l) => l.handle)

    const ipIndex = handles.indexOf(validateIbexHubIp)
    const signatureIndex = handles.indexOf(verifyIbexHubSignature)
    const handlerIndex = handles.indexOf(hubTransactionsHandler)

    // The rate limit comes first, the raw body parser sits between the IP
    // check and the signature check.
    expect(ipIndex).toBeGreaterThan(0)
    expect(signatureIndex).toBeGreaterThan(ipIndex + 1)
    expect(handlerIndex).toBe(signatureIndex + 1)
  })

  it("answers 200 and hands a crypto receive to recordIbexCreditSignal", async () => {
    const res = response()

    hubTransactionsHandler(
      request({
        event: "Transactions",
        transaction: { id: "877be576", transactionTypeId: 9, status: "completed" },
        crypto: { network: "Ethereum", networkTransactionId: "0xd8c9" },
      }) as never,
      res as never,
    )
    await flush()

    expect(res.status).toHaveBeenCalledWith(200)
    expect(mockRecordSignal).toHaveBeenCalledWith({
      ibexTransactionId: "877be576",
      webhookId: "msg_1",
    })
  })

  it("answers before the credit is handled", () => {
    const res = response()
    mockRecordSignal.mockImplementation(() => {
      res.order.push("handled")
      return Promise.resolve("recorded")
    })

    hubTransactionsHandler(
      request({
        event: "Transactions",
        transaction: { id: "t", transactionTypeId: 9 },
      }) as never,
      res as never,
    )

    expect(res.order).toEqual(["status 200", "handled"])
  })

  it.each([
    [
      "a Lightning receive",
      { event: "Transactions", transaction: { id: "t", transactionTypeId: 1 } },
    ],
    [
      "a crypto send",
      { event: "Transactions", transaction: { id: "t", transactionTypeId: 10 } },
    ],
    ["another event", { event: "Applicants", id: "a", status: "approved" }],
    [
      "a transaction without an id",
      { event: "Transactions", transaction: { transactionTypeId: 9 } },
    ],
    ["an empty body", {}],
  ])("answers 200 and does nothing else for %s", async (_label, body) => {
    const res = response()

    hubTransactionsHandler(request(body) as never, res as never)
    await flush()

    expect(res.status).toHaveBeenCalledWith(200)
    expect(mockRecordSignal).not.toHaveBeenCalled()
  })

  it("still answers 200 when handling the credit fails", async () => {
    mockRecordSignal.mockRejectedValue(new Error("boom"))
    const res = response()

    hubTransactionsHandler(
      request({
        event: "Transactions",
        transaction: { id: "t", transactionTypeId: 9 },
      }) as never,
      res as never,
    )
    await flush()

    expect(res.status).toHaveBeenCalledWith(200)
  })
})
