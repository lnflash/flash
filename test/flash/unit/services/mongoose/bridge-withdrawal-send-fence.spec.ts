jest.mock("@services/mongoose/schema", () => ({
  BridgeWithdrawal: {
    collection: { createIndex: jest.fn() },
    findOneAndUpdate: jest.fn(),
    findOne: jest.fn(),
    updateOne: jest.fn(),
  },
}))

import { toBridgeTransferId } from "@domain/primitives/bridge"
import { BridgeWithdrawalCompletionProofRequiredError } from "@domain/bridge/withdrawal-outcome"
import { RepositoryError } from "@domain/errors"
import {
  reserveWithdrawalCryptoSendAttempt,
  findUnresolvedWithdrawalSendByAccountId,
  recordWithdrawalCryptoSendReceipt,
  updateWithdrawalSendFailed,
  updateWithdrawalStatus,
  noteWithdrawalCryptoSendReviewed,
} from "@services/mongoose/bridge-accounts"

const model = jest.requireMock("@services/mongoose/schema").BridgeWithdrawal as {
  collection: { createIndex: jest.Mock }
  findOneAndUpdate: jest.Mock
  findOne: jest.Mock
  updateOne: jest.Mock
}
const attempt = {
  id: "row",
  accountId: "owner",
  bridgeTransferId: "transfer",
  attemptId: "attempt-one",
  sourceWalletId: "source-wallet",
  cryptoSendInfoId: "send-info",
  amount: "50.00",
}

beforeEach(() => {
  jest.resetAllMocks()
  model.collection.createIndex.mockResolvedValue("bridge_withdrawal_unresolved_send")
  model.findOneAndUpdate.mockResolvedValue({
    id: "row",
    status: "send_unknown",
    cryptoSendAttemptId: "attempt-one",
  })
})

it("verifies the unique account fence and atomically journals immutable attempt data before dispatch", async () => {
  expect(await reserveWithdrawalCryptoSendAttempt(attempt)).not.toBeInstanceOf(Error)
  expect(model.collection.createIndex).toHaveBeenCalledWith(
    { accountId: 1 },
    {
      unique: true,
      name: "bridge_withdrawal_unresolved_send",
      partialFilterExpression: { status: "send_unknown" },
      commitQuorum: "majority",
    },
  )
  expect(model.findOneAndUpdate).toHaveBeenCalledWith(
    {
      _id: { $eq: "row" },
      accountId: { $eq: "owner" },
      bridgeTransferId: { $eq: "transfer" },
      status: "submitted",
      ibexPayoutId: { $exists: false },
      cryptoSendAttemptId: { $exists: false },
      cryptoSendState: { $exists: false },
    },
    {
      $set: {
        status: "send_unknown",
        cryptoSendState: "attempted",
        cryptoSendAttemptId: "attempt-one",
        cryptoSendAttemptedAt: expect.any(Date),
        cryptoSendSourceWalletId: "source-wallet",
        cryptoSendInfoId: "send-info",
        cryptoSendAmount: "50.00",
        updatedAt: expect.any(Date),
      },
    },
    { new: true, writeConcern: { w: "majority", j: true } },
  )
  expect(model.collection.createIndex.mock.invocationCallOrder[0]).toBeLessThan(
    model.findOneAndUpdate.mock.invocationCallOrder[0],
  )
})

it.each(["rejected", "wrong-result"])(
  "fails closed on index %s before any fence write",
  async (kind) => {
    if (kind === "rejected")
      model.collection.createIndex.mockRejectedValue(new Error("PRIVATE_INDEX_ERROR"))
    else model.collection.createIndex.mockResolvedValue("wrong-index")
    const result = await reserveWithdrawalCryptoSendAttempt(attempt)
    expect(result).toBeInstanceOf(RepositoryError)
    expect((result as Error).message).not.toContain("PRIVATE_INDEX_ERROR")
    expect(model.findOneAndUpdate).not.toHaveBeenCalled()
  },
)

it.each(["no-match", "write-concern-error"])(
  "never grants dispatch authority after %s",
  async (kind) => {
    if (kind === "no-match") model.findOneAndUpdate.mockResolvedValue(null)
    else
      model.findOneAndUpdate.mockRejectedValue(new Error("PRIVATE_MAJORITY_WRITE_ERROR"))
    expect(await reserveWithdrawalCryptoSendAttempt(attempt)).toBeInstanceOf(
      RepositoryError,
    )
    expect(model.findOneAndUpdate).toHaveBeenCalledTimes(1)
  },
)

it("admits only one distinct-row attempt for the same account under the unique index", async () => {
  const heldAccounts = new Set<string>()
  model.findOneAndUpdate.mockImplementation(
    async (
      query: { accountId: { $eq: string } },
      update: { $set: Record<string, unknown> },
    ) => {
      // Models the Mongo unique partial index's atomic constraint, without I/O.
      if (heldAccounts.has(query.accountId.$eq)) throw new Error("E11000 duplicate key")
      heldAccounts.add(query.accountId.$eq)
      return { ...update.$set }
    },
  )
  const results = await Promise.all([
    reserveWithdrawalCryptoSendAttempt(attempt),
    reserveWithdrawalCryptoSendAttempt({
      ...attempt,
      id: "other-row",
      attemptId: "attempt-two",
    }),
  ])
  expect(results.filter((result) => result instanceof Error)).toHaveLength(1)
  expect(results.filter((result) => !(result instanceof Error))).toHaveLength(1)
  expect(heldAccounts.size).toBe(1)
})

it("blocks all unresolved historical classes using a primary majority read", async () => {
  model.findOne.mockResolvedValue({ status: "send_failed" })
  expect(await findUnresolvedWithdrawalSendByAccountId("owner")).toMatchObject({
    status: "send_failed",
  })
  expect(model.findOne).toHaveBeenCalledWith(
    {
      accountId: { $eq: "owner" },
      $or: expect.arrayContaining([
        { status: { $in: ["submitted", "send_unknown"] } },
        { status: "send_failed", cryptoSendState: { $ne: "not_dispatched" } },
        { status: "usdt_sent", $or: [{ ibexPayoutId: null }, { ibexPayoutId: "" }] },
      ]),
    },
    undefined,
    { readPreference: "primary", readConcern: { level: "majority" } },
  )
  model.findOne.mockRejectedValue(new Error("PRIVATE_READ_ERROR"))
  expect(await findUnresolvedWithdrawalSendByAccountId("owner")).toMatchObject({
    message: "Unable to verify unresolved withdrawal sends",
  })
})

it("records a receipt only for the same attempt and never promotes it to sent/settled", async () => {
  await recordWithdrawalCryptoSendReceipt("row", "payout", undefined, "attempt-one")
  expect(model.findOneAndUpdate).toHaveBeenCalledWith(
    {
      _id: { $eq: "row" },
      status: "send_unknown",
      cryptoSendState: "attempted",
      cryptoSendAttemptId: { $eq: "attempt-one" },
      ibexPayoutId: { $exists: false },
    },
    { status: "send_unknown", ibexPayoutId: "payout", updatedAt: expect.any(Date) },
    { new: true },
  )
})

it("keeps private receipt persistence errors inside the repository boundary", async () => {
  model.findOneAndUpdate.mockRejectedValue(new Error("PRIVATE_PROVIDER_RECEIPT_BODY"))
  const result = await recordWithdrawalCryptoSendReceipt(
    "row",
    "payout",
    undefined,
    "attempt-one",
  )
  expect(result).toMatchObject({ message: "Unable to record withdrawal send receipt" })
})

it("cannot overwrite any attempt fence with a definitive not-dispatched failure", async () => {
  await updateWithdrawalSendFailed(
    "row",
    "transfer",
    "50",
    "usd",
    "address",
    "Fixed preflight failure",
  )
  expect(model.findOneAndUpdate).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "submitted",
      cryptoSendAttemptId: { $exists: false },
      cryptoSendState: { $exists: false },
    }),
    expect.objectContaining({ status: "send_failed", cryptoSendState: "not_dispatched" }),
    { new: true },
  )
})

it("allows only authoritative completion to clear unknown and leaves failed webhooks unable to clear it", async () => {
  await updateWithdrawalStatus(
    toBridgeTransferId("transfer"),
    "completed",
    undefined,
    "payment_processed",
  )
  expect(model.findOneAndUpdate.mock.calls[0][0].status.$in).toContain("send_unknown")
  model.findOneAndUpdate.mockClear()
  await updateWithdrawalStatus(toBridgeTransferId("transfer"), "failed")
  expect(model.findOneAndUpdate.mock.calls[0][0].status.$in).not.toContain("send_unknown")
})

it("returns a typed review refusal rather than clearing uncertainty from an event-name-only completion", async () => {
  model.findOneAndUpdate.mockResolvedValue(null)
  model.findOne.mockResolvedValue({ status: "send_unknown" })
  expect(
    await updateWithdrawalStatus(toBridgeTransferId("transfer"), "completed"),
  ).toBeInstanceOf(BridgeWithdrawalCompletionProofRequiredError)
  expect(model.findOneAndUpdate.mock.calls[0][0].status.$in).not.toContain("send_unknown")
  expect(model.findOneAndUpdate.mock.calls[0][0].status.$in).not.toContain("send_failed")
})

it("rotates review position without changing status or send timestamps", async () => {
  await noteWithdrawalCryptoSendReviewed("row")
  expect(model.updateOne).toHaveBeenCalledWith(
    expect.objectContaining({ _id: { $eq: "row" } }),
    { $set: { cryptoSendReviewedAt: expect.any(Date) } },
  )
})
