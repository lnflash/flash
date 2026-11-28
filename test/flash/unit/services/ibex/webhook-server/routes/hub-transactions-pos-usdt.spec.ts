// The IBEX Hub route hands a signed crypto receive to the POS USDT checkout
// only when that checkout is switched on, and always to the Bridge path first.
// With it on, a crypto receive is answered 200 only once POS has durably
// recorded it (or known it is not a POS credit), and 503 when storage failed,
// so IBEX redelivers. No IBEX read-back happens before the answer.

const mockRecordSignal = jest.fn()
const mockPosRecord = jest.fn()

jest.mock("@services/ibex/webhook-server/middleware", () => ({
  validateIbexHubIp: jest.fn((_req, _res, next) => next()),
  verifyIbexHubSignature: jest.fn((_req, _res, next) => next()),
}))
jest.mock("@app/bridge/match-ibex-deposits", () => ({
  IBEX_CRYPTO_RECEIVE_TYPE_ID: 9,
  recordIbexCreditSignal: (...args: unknown[]) => mockRecordSignal(...args),
}))
jest.mock("@services/pos-usdt-checkout/hub-signal", () => ({
  recordPosUsdtHubEvent: (...args: unknown[]) => mockPosRecord(...args),
}))
jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { hubTransactionsHandler } from "@services/ibex/webhook-server/routes/hub-transactions"

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
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
const receive = {
  event: "Transactions",
  transaction: { id: "t-1", transactionTypeId: 9, accountId: "w", amount: 1 },
  receiveInfo: { id: "ri-1", network: "ethereum", txid: "0x" + "1".repeat(64) },
}

const saved = process.env.POS_USDT_CHECKOUT_ENABLED
afterEach(() => {
  jest.useRealTimers()
  if (saved === undefined) delete process.env.POS_USDT_CHECKOUT_ENABLED
  else process.env.POS_USDT_CHECKOUT_ENABLED = saved
})
beforeEach(() => {
  jest.clearAllMocks()
  mockRecordSignal.mockResolvedValue("no_bridge_deposit")
  mockPosRecord.mockResolvedValue({ result: "not_pos" })
})

it("leaves POS USDT checkout out by default, answering at once", async () => {
  delete process.env.POS_USDT_CHECKOUT_ENABLED
  const res = response()
  hubTransactionsHandler(request(receive) as never, res as never)
  // Answered synchronously, before any work.
  expect(res.order).toEqual(["status 200"])
  await flush()
  expect(mockRecordSignal).toHaveBeenCalledWith({
    ibexTransactionId: "t-1",
    webhookId: "msg_1",
  })
  expect(mockPosRecord).not.toHaveBeenCalled()
})

it("answers 200 only after POS has recorded the credit, and reads it back after", async () => {
  process.env.POS_USDT_CHECKOUT_ENABLED = "true"
  const stored = deferred<unknown>()
  const readBack = jest.fn(() => {
    res.order.push("read back")
    return Promise.resolve("posted")
  })
  mockPosRecord.mockImplementation(() => {
    res.order.push("recording")
    return stored.promise
  })
  const res = response()
  const done = hubTransactionsHandler(request(receive) as never, res as never)
  await flush()

  // The Bridge path is already running; the answer waits on storage.
  expect(mockRecordSignal).toHaveBeenCalledWith({
    ibexTransactionId: "t-1",
    webhookId: "msg_1",
  })
  expect(mockPosRecord).toHaveBeenCalledWith(receive)
  expect(res.status).not.toHaveBeenCalled()

  stored.resolve({ result: "detected", readBack })
  await done
  await flush()
  expect(res.order).toEqual(["recording", "status 200", "read back"])
})

it("does not hold the answer for the IBEX read-back, nor fail it when that throws", async () => {
  process.env.POS_USDT_CHECKOUT_ENABLED = "true"
  const never = deferred<unknown>()
  mockPosRecord.mockResolvedValue({ result: "detected", readBack: () => never.promise })
  const res = response()
  await hubTransactionsHandler(request(receive) as never, res as never)
  expect(res.status).toHaveBeenCalledWith(200)

  mockPosRecord.mockResolvedValue({
    result: "detected",
    readBack: () => Promise.reject(new Error("IBEX offline")),
  })
  const again = response()
  await hubTransactionsHandler(request(receive) as never, again as never)
  await flush()
  expect(again.status).toHaveBeenCalledTimes(1)
  expect(again.status).toHaveBeenCalledWith(200)
})

it.each([["not_pos"], ["ignored"], ["already_posted"], ["rejected"], ["disabled"]])(
  "answers 200 when POS knows the credit needs nothing more (%s)",
  async (result) => {
    process.env.POS_USDT_CHECKOUT_ENABLED = "true"
    mockPosRecord.mockResolvedValue({ result })
    const res = response()
    await hubTransactionsHandler(request(receive) as never, res as never)
    expect(res.status).toHaveBeenCalledWith(200)
  },
)

it("asks IBEX to retry when storage fails, the Bridge path still running, and records on the retry", async () => {
  process.env.POS_USDT_CHECKOUT_ENABLED = "true"
  mockPosRecord.mockRejectedValueOnce(new Error("mongo down"))
  const res = response()
  await hubTransactionsHandler(request(receive) as never, res as never)
  expect(res.status).toHaveBeenCalledWith(503)
  expect(res.status).not.toHaveBeenCalledWith(200)
  expect(mockRecordSignal).toHaveBeenCalledTimes(1)

  // IBEX redelivers once storage is back.
  mockPosRecord.mockResolvedValueOnce({
    result: "detected",
    readBack: jest.fn(async () => "unverified"),
  })
  const retry = response()
  await hubTransactionsHandler(request(receive) as never, retry as never)
  expect(retry.status).toHaveBeenCalledWith(200)
  expect(mockPosRecord).toHaveBeenCalledTimes(2)
})

it("asks IBEX to retry when recording outlasts its wait, and answers only once", async () => {
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] })
  process.env.POS_USDT_CHECKOUT_ENABLED = "true"
  const slow = deferred<unknown>()
  mockPosRecord.mockReturnValue(slow.promise)
  const res = response()
  const done = hubTransactionsHandler(request(receive) as never, res as never)
  await flush()
  expect(res.status).not.toHaveBeenCalled()

  await jest.advanceTimersByTimeAsync(3_000)
  await done
  expect(res.order).toEqual(["status 503"])

  // The late write lands; the redelivery finds it stored.
  slow.resolve({ result: "detected" })
  await flush()
  expect(res.order).toEqual(["status 503"])
})

it("answers other notifications at once with POS on, handing nothing to POS", async () => {
  process.env.POS_USDT_CHECKOUT_ENABLED = "true"
  for (const body of [
    { event: "Transactions", transaction: { id: "t", transactionTypeId: 1 } },
    { event: "Applicants", id: "a", status: "approved" },
    { event: "Transactions", transaction: { transactionTypeId: 9 } },
    {},
  ]) {
    const res = response()
    hubTransactionsHandler(request(body) as never, res as never)
    expect(res.order).toEqual(["status 200"])
  }
  await flush()
  expect(mockPosRecord).not.toHaveBeenCalled()
  expect(mockRecordSignal).not.toHaveBeenCalled()
})

it("keeps the Bridge path working when POS handling throws", async () => {
  process.env.POS_USDT_CHECKOUT_ENABLED = "true"
  mockPosRecord.mockImplementation(() => {
    throw new Error("boom")
  })
  const res = response()
  await hubTransactionsHandler(request(receive) as never, res as never)
  expect(mockRecordSignal).toHaveBeenCalled()
  expect(res.status).toHaveBeenCalledWith(503)
})
