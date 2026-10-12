import {
  INTERNAL_TRANSFER_INVOICE_TTL_SECONDS,
  InternalTransferInvoice,
  PaymentSplitExecution,
  PaymentSplitRule,
} from "@services/mongoose/schema"
import {
  deleteInternalTransferInvoice,
  insertInternalTransferInvoice,
  isInternalTransferInvoice,
  recordInternalTransferInvoice,
} from "@services/mongoose/internal-transfer-invoices"
import { PaymentSplitExecutionsRepository } from "@services/mongoose/payment-split-executions"
import { PaymentSplitRulesRepository } from "@services/mongoose/payment-split-rules"

const executionFields = (triggerKey: string, ruleId: string) => ({
  triggerKey,
  ruleId,
  walletId: "source-wallet",
  destinationWalletId: "dest-wallet",
  currency: "USDT",
  triggerAmountMinor: "1000000",
  shareCents: 10,
  status: "pending" as const,
})

describe("payment split repositories (ENG-653)", () => {
  beforeAll(async () => {
    await PaymentSplitExecution.syncIndexes()
    await InternalTransferInvoice.syncIndexes()
  })

  beforeEach(async () => {
    await PaymentSplitExecution.deleteMany({})
    await InternalTransferInvoice.deleteMany({})
    await PaymentSplitRule.deleteMany({})
  })

  it("replaces a wallet's whole rule set and lists wallets with enabled rules", async () => {
    const rules = PaymentSplitRulesRepository()

    const first = await rules.replaceForWallet("wallet-a", [
      { destinationWalletId: "dest-1", percent: 10 },
      { destinationWalletId: "dest-2", percent: 20 },
    ])
    if (first instanceof Error) throw first
    expect(first).toHaveLength(2)

    const second = await rules.replaceForWallet("wallet-a", [
      { destinationWalletId: "dest-3", percent: 50 },
    ])
    if (second instanceof Error) throw second

    const listed = await rules.listByWalletId("wallet-a", { enabledOnly: true })
    expect(listed).toEqual([
      expect.objectContaining({
        destinationWalletId: "dest-3",
        percent: 50,
        enabled: true,
      }),
    ])
    expect(await rules.findById(second[0].id)).toMatchObject({ walletId: "wallet-a" })
    expect(await rules.findById("not-an-object-id")).toBeNull()
    expect(await rules.listWalletIdsWithEnabledRules()).toEqual(["wallet-a"])

    expect(await rules.deleteById(second[0].id)).toBe(true)
    expect(await rules.deleteById(second[0].id)).toBe(false)
    expect(await rules.listWalletIdsWithEnabledRules()).toEqual([])
  })

  it("rejects a duplicate (triggerKey, ruleId) as a typed no-op", async () => {
    const repo = PaymentSplitExecutionsRepository()
    const triggerKey = "d".repeat(64)

    const first = await repo.insert(executionFields(triggerKey, "rule-1"))
    const second = await repo.insert(executionFields(triggerKey, "rule-1"))
    const otherRule = await repo.insert(executionFields(triggerKey, "rule-2"))

    expect(first).toMatchObject({ inserted: true })
    expect(second).toEqual({ inserted: false })
    expect(otherRule).toMatchObject({ inserted: true })
    expect(await PaymentSplitExecution.countDocuments({ triggerKey })).toBe(2)
  })

  it("lets exactly one of several concurrent claimers claim a pending row", async () => {
    const repo = PaymentSplitExecutionsRepository()
    await repo.insert(executionFields("e".repeat(64), "rule-1"))

    const now = new Date(Date.now() + 1000)
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => repo.claimNextDue(now)),
    )

    const claimed = claims.filter((c) => c !== null && !(c instanceof Error))
    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toMatchObject({ status: "sending" })
  })

  it("does not claim a row before its first nextAttemptAt", async () => {
    const repo = PaymentSplitExecutionsRepository()
    const now = new Date()
    const claimableAt = new Date(now.getTime() + 120_000)
    await repo.insert({
      ...executionFields("f".repeat(64), "rule-1"),
      nextAttemptAt: claimableAt,
      now,
    })

    expect(await repo.claimNextDue(now)).toBeNull()
    expect(await repo.claimNextDue(claimableAt)).toMatchObject({ status: "sending" })
  })

  it("has a TTL index on internal-transfer markers that outlives the reconcile lookback", async () => {
    const indexes = await InternalTransferInvoice.collection.indexes()
    const ttl = indexes.find((index) => index.expireAfterSeconds !== undefined)

    expect(ttl).toMatchObject({
      key: { createdAt: 1 },
      expireAfterSeconds: INTERNAL_TRANSFER_INVOICE_TTL_SECONDS,
    })
    expect(INTERNAL_TRANSFER_INVOICE_TTL_SECONDS).toBe(30 * 24 * 60 * 60)
  })

  it("records a marker idempotently and finds it case-insensitively", async () => {
    const hash = "AB".repeat(32)
    const args = {
      paymentHash: hash,
      senderWalletId: "sender",
      recipientWalletId: "recipient",
      origin: "intraledger" as const,
    }

    expect(await recordInternalTransferInvoice(args)).toBe(true)
    expect(await recordInternalTransferInvoice(args)).toBe(true)
    expect(await isInternalTransferInvoice(hash.toLowerCase())).toBe(true)
    expect(await isInternalTransferInvoice("cd".repeat(32))).toBe(false)
    expect(await InternalTransferInvoice.countDocuments({})).toBe(1)
  })

  it("keeps one marker per (hash, sender, origin), not one per hash", async () => {
    const hash = "ef".repeat(32)
    const lnSend = (senderWalletId: string) => ({
      paymentHash: hash,
      senderWalletId,
      origin: "ln-send" as const,
    })

    // Same sender and origin twice: one row, the second insert is a no-op.
    expect(await insertInternalTransferInvoice(lnSend("sender-a"))).toEqual({
      created: true,
    })
    expect(await insertInternalTransferInvoice(lnSend("sender-a"))).toEqual({
      created: false,
    })
    expect(await InternalTransferInvoice.countDocuments({ paymentHash: hash })).toBe(1)

    // A second sender of the same hash owns a row of its own.
    expect(await insertInternalTransferInvoice(lnSend("sender-b"))).toEqual({
      created: true,
    })
    expect(await InternalTransferInvoice.countDocuments({ paymentHash: hash })).toBe(2)

    // The same sender under another origin is a distinct row too.
    expect(
      await insertInternalTransferInvoice({
        ...lnSend("sender-a"),
        origin: "lnurl-send",
      }),
    ).toEqual({ created: true })
    expect(await InternalTransferInvoice.countDocuments({ paymentHash: hash })).toBe(3)

    // Withdrawing A's ln-send row leaves B's, so the hash stays internal.
    expect(await deleteInternalTransferInvoice(lnSend("sender-a"))).toBe(true)
    expect(await deleteInternalTransferInvoice(lnSend("sender-a"))).toBe(false)
    expect(await isInternalTransferInvoice(hash)).toBe(true)
    expect(await InternalTransferInvoice.countDocuments({ paymentHash: hash })).toBe(2)

    const indexes = await InternalTransferInvoice.collection.indexes()
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: { paymentHash: 1, senderWalletId: 1, origin: 1 },
          unique: true,
        }),
      ]),
    )
    expect(
      indexes.find(
        (index) =>
          index.unique &&
          JSON.stringify(index.key) === JSON.stringify({ paymentHash: 1 }),
      ),
    ).toBeUndefined()
  })
})
