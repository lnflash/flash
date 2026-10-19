import { PaymentSplitsConfig } from "@config"

import { buildLegs } from "@app/payment-splits/build-legs"

import {
  INTERNAL_TRANSFER_INVOICE_TTL_SECONDS,
  InternalTransferInvoice,
  PaymentSplitExecution,
  PaymentSplitRule,
  SplitReceiveAccount,
} from "@services/mongoose/schema"
import {
  deleteInternalTransferInvoice,
  insertInternalTransferInvoice,
  isInternalTransferInvoice,
  recordInternalTransferInvoice,
} from "@services/mongoose/internal-transfer-invoices"
import { PaymentSplitExecutionsRepository } from "@services/mongoose/payment-split-executions"
import { PaymentSplitRulesRepository } from "@services/mongoose/payment-split-rules"
import { SplitReceiveAccountsRepository } from "@services/mongoose/split-receive-accounts"

const executionFields = (
  triggerKey: string,
  ruleId: string,
  {
    destinationWalletId = "dest-wallet",
    legKind = "share",
  }: { destinationWalletId?: string; legKind?: "share" | "net" } = {},
) => ({
  triggerKey,
  legKind,
  ruleId,
  walletId: "source-wallet",
  sourceIbexAccountId: "shadow-account",
  destinationWalletId,
  currency: "USDT",
  grossMinor: "1000000",
  shareCents: 10,
  status: "pending" as const,
})

describe("payment split repositories (ENG-717)", () => {
  beforeAll(async () => {
    await PaymentSplitExecution.syncIndexes()
    await InternalTransferInvoice.syncIndexes()
    await SplitReceiveAccount.syncIndexes()
  })

  beforeEach(async () => {
    await PaymentSplitExecution.deleteMany({})
    await InternalTransferInvoice.deleteMany({})
    await PaymentSplitRule.deleteMany({})
    await SplitReceiveAccount.deleteMany({})
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

  it("rejects a duplicate (triggerKey, legKind, destinationWalletId) as a typed no-op", async () => {
    const repo = PaymentSplitExecutionsRepository()
    const triggerKey = "d".repeat(64)

    const first = await repo.insert(executionFields(triggerKey, "rule-1"))
    const second = await repo.insert(executionFields(triggerKey, "rule-1"))
    // A webhook replay after the rules were re-saved: same payout target under
    // a new rule id. Still a duplicate, so the partner is not paid twice.
    const rewrittenRule = await repo.insert(executionFields(triggerKey, "rule-2"))
    // Another destination of the same receive is a payout of its own.
    const otherDestination = await repo.insert(
      executionFields(triggerKey, "rule-3", { destinationWalletId: "dest-wallet-2" }),
    )
    // The NET leg to the merchant on the same receive: different legKind, so
    // it coexists with a share leg to the same wallet (v1's index could not).
    const netLeg = await repo.insert(
      executionFields(triggerKey, "merchant", {
        destinationWalletId: "source-wallet",
        legKind: "net",
      }),
    )

    expect(first).toMatchObject({ inserted: true })
    expect(second).toEqual({ inserted: false })
    expect(rewrittenRule).toEqual({ inserted: false })
    expect(otherDestination).toMatchObject({ inserted: true })
    expect(netLeg).toMatchObject({ inserted: true })
    expect(await PaymentSplitExecution.countDocuments({ triggerKey })).toBe(3)

    const indexes = await PaymentSplitExecution.collection.indexes()
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: { triggerKey: 1, legKind: 1, destinationWalletId: 1 },
          unique: true,
        }),
      ]),
    )
    // v1's index is gone (dropped by the migration, not re-created by the
    // schema): a share leg to the merchant and the net leg must coexist.
    expect(
      indexes.find(
        (index) =>
          index.unique &&
          JSON.stringify(index.key) ===
            JSON.stringify({ triggerKey: 1, walletId: 1, destinationWalletId: 1 }),
      ),
    ).toBeUndefined()
    expect(
      indexes.find(
        (index) =>
          index.unique &&
          JSON.stringify(index.key) === JSON.stringify({ triggerKey: 1, ruleId: 1 }),
      ),
    ).toBeUndefined()
  })

  it("keeps split receive accounts unique per wallet and per IBEX account", async () => {
    const repo = SplitReceiveAccountsRepository()

    const first = await repo.insert({
      walletId: "wallet-s",
      ibexAccountId: "shadow-1",
      currency: "USDT",
      lnurlp: "lnurl1abc",
    })
    expect(first).toEqual({ created: true })

    // Same wallet again: typed no-op (idempotent ensure).
    expect(
      await repo.insert({
        walletId: "wallet-s",
        ibexAccountId: "shadow-2",
        currency: "USDT",
      }),
    ).toEqual({ created: false })
    // Same IBEX account under another wallet: also a duplicate.
    expect(
      await repo.insert({
        walletId: "wallet-t",
        ibexAccountId: "shadow-1",
        currency: "USDT",
      }),
    ).toEqual({ created: false })

    expect(await repo.findByWalletId("wallet-s")).toMatchObject({
      ibexAccountId: "shadow-1",
      lnurlp: "lnurl1abc",
    })
    expect(await repo.findByWalletId("wallet-none")).toBeNull()
    expect(await repo.findByIbexAccountId("shadow-1")).toMatchObject({
      walletId: "wallet-s",
    })
    expect(await repo.findByIbexAccountId("shadow-none")).toBeNull()
    const all = await repo.listAll()
    if (all instanceof Error) throw all
    expect(all.map((s) => s.walletId)).toEqual(["wallet-s"])

    const indexes = await SplitReceiveAccount.collection.indexes()
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { walletId: 1 }, unique: true }),
        expect.objectContaining({ key: { ibexAccountId: 1 }, unique: true }),
      ]),
    )
  })

  it("carries createdAt forward for a destination that survives a re-save", async () => {
    const rules = PaymentSplitRulesRepository()
    const firstSave = new Date("2026-10-11T12:00:00Z")
    const reSave = new Date("2026-10-11T12:10:00Z")

    const first = await rules.replaceForWallet(
      "wallet-b",
      [
        { destinationWalletId: "kept", percent: 10 },
        { destinationWalletId: "dropped", percent: 20 },
      ],
      { now: firstSave },
    )
    if (first instanceof Error) throw first

    const second = await rules.replaceForWallet(
      "wallet-b",
      [
        { destinationWalletId: "kept", percent: 15 },
        { destinationWalletId: "new", percent: 5 },
      ],
      { now: reSave },
    )
    if (second instanceof Error) throw second

    const byDestination = new Map(second.map((rule) => [rule.destinationWalletId, rule]))
    expect(byDestination.get("kept")).toMatchObject({
      percent: 15,
      createdAt: firstSave,
      updatedAt: reSave,
    })
    expect(byDestination.get("new")).toMatchObject({ createdAt: reSave })
    expect(byDestination.has("dropped")).toBe(false)
  })

  it("builds legs for an unrecorded receive that settled before a re-save of the same destination", async () => {
    const enabled = PaymentSplitsConfig.enabled
    PaymentSplitsConfig.enabled = true
    try {
      const rules = PaymentSplitRulesRepository()
      const firstSave = new Date("2026-10-11T11:00:00Z")
      const receivedAt = new Date("2026-10-11T12:00:00Z")
      const reSave = new Date("2026-10-11T12:02:00Z")
      const reconcileAt = new Date("2026-10-11T12:15:00Z")

      // The partner has been on the wallet since 11:00.
      const saved = await rules.replaceForWallet(
        "wallet-c",
        [{ destinationWalletId: "partner", percent: 10 }],
        { now: firstSave },
      )
      if (saved instanceof Error) throw saved

      // A receive settles at 12:00 and the webhook's build fails. At 12:02 the
      // merchant re-saves, adding a destination and keeping the partner.
      const reSaved = await rules.replaceForWallet(
        "wallet-c",
        [
          { destinationWalletId: "partner", percent: 10 },
          { destinationWalletId: "late-partner", percent: 5 },
        ],
        { now: reSave },
      )
      if (reSaved instanceof Error) throw reSaved

      // The reconcile at 12:15 builds the partner's share and the net leg. The
      // destination added after the receive is still skipped (receivedAt gate).
      const triggerKey = "c".repeat(64)
      const result = await buildLegs({
        walletId: "wallet-c",
        sourceIbexAccountId: "shadow-c",
        triggerKey,
        paymentHash: triggerKey,
        grossAmount: 100,
        currency: "USDT",
        receivedAt,
        now: reconcileAt,
      })
      if (result instanceof Error) throw result

      // partner share (10 USDT = 1_000_000 micros * 10% / 10_000 = 1000 cents)
      // plus the net leg.
      expect(result).toMatchObject({ recorded: 2 })
      const rows = await PaymentSplitExecution.find({ triggerKey })
        .sort({ legKind: 1 })
        .lean()
      expect(rows.map((row) => row.destinationWalletId).sort()).toEqual([
        "partner",
        "wallet-c",
      ])
      expect(rows.find((row) => row.legKind === "net")).toMatchObject({
        destinationWalletId: "wallet-c",
        shareCents: 9000,
      })
    } finally {
      PaymentSplitsConfig.enabled = enabled
    }
  })

  it("disables a rule once, and a disabled rule builds no share leg (ENG-660)", async () => {
    const enabled = PaymentSplitsConfig.enabled
    PaymentSplitsConfig.enabled = true
    try {
      const rules = PaymentSplitRulesRepository()
      const saved = await rules.replaceForWallet("wallet-d", [
        { destinationWalletId: "closed-partner", percent: 10 },
        { destinationWalletId: "open-partner", percent: 20 },
      ])
      if (saved instanceof Error) throw saved
      const closed = saved.find((r) => r.destinationWalletId === "closed-partner")
      if (!closed) throw new Error("rule not saved")

      const disabledAt = new Date("2026-10-12T12:00:00Z")
      // Only the first call flips the flag, so only it notifies the owner.
      expect(
        await rules.disableForDestination("wallet-d", "closed-partner", {
          now: disabledAt,
        }),
      ).toBe(true)
      expect(await rules.disableForDestination("wallet-d", "closed-partner")).toBe(false)
      expect(await rules.disableForDestination("wallet-d", "no-such-partner")).toBe(false)
      expect(await rules.findById(closed.id)).toMatchObject({
        enabled: false,
        updatedAt: disabledAt,
      })
      // The disabled rule still exists; a destination never configured does not.
      expect(await rules.existsForDestination("wallet-d", "closed-partner")).toBe(true)
      expect(await rules.existsForDestination("wallet-d", "no-such-partner")).toBe(false)

      // Webhook and reconcile both build through buildLegs.
      const triggerKey = "d".repeat(64)
      const result = await buildLegs({
        walletId: "wallet-d",
        sourceIbexAccountId: "shadow-d",
        triggerKey,
        paymentHash: triggerKey,
        grossAmount: 100,
        currency: "USDT",
      })
      if (result instanceof Error) throw result

      // open-partner's share + the net leg (the closed partner's share folded
      // into the net by receivedAt/skipped-min folding — here by inactivity
      // being a save-time reject, so only enabled rules are listed).
      expect(result).toMatchObject({ recorded: 2 })
      const rows = await PaymentSplitExecution.find({ triggerKey }).lean()
      expect(
        rows
          .filter((row) => row.legKind === "share")
          .map((row) => row.destinationWalletId),
      ).toEqual(["open-partner"])

      // A wallet whose only rule is disabled is not reconciled at all.
      const only = await rules.replaceForWallet("wallet-e", [
        { destinationWalletId: "closed-partner", percent: 10 },
      ])
      if (only instanceof Error) throw only
      expect(await rules.disableForDestination("wallet-e", "closed-partner")).toBe(true)
      expect(await rules.listWalletIdsWithEnabledRules()).toEqual(["wallet-d"])
    } finally {
      PaymentSplitsConfig.enabled = enabled
    }
  })

  it("lets exactly one of several concurrent claimers claim a pending leg", async () => {
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

  it("does not claim a leg before its first nextAttemptAt", async () => {
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

  it("inserts one fold per (trigger, merchant), replay-safe", async () => {
    const repo = PaymentSplitExecutionsRepository()
    const triggerKey = "9".repeat(64)
    await repo.insert(executionFields(triggerKey, "rule-1"))

    const execution = {
      triggerKey,
      ruleId: "rule-1",
      walletId: "source-wallet",
      sourceIbexAccountId: "shadow-account",
      currency: "USDT",
      grossMinor: "1000000",
      shareCents: 10,
    }
    expect(await repo.insertFold(execution, "InactiveAccountError")).toBe(true)
    // A replayed fold (the fold row itself failing terminally again) is a no-op.
    expect(await repo.insertFold(execution, "InactiveAccountError")).toBe(false)

    const folds = await PaymentSplitExecution.find({
      triggerKey,
      destinationWalletId: "source-wallet",
    }).lean()
    expect(folds).toHaveLength(1)
    expect(folds[0]).toMatchObject({
      legKind: "share",
      status: "pending",
      lastError: "fold: InactiveAccountError",
    })
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

  it("accepts the split payout origin on a marker", async () => {
    const hash = "ab".repeat(32)
    expect(
      await insertInternalTransferInvoice({
        paymentHash: hash,
        recipientWalletId: "partner",
        origin: "split",
      }),
    ).toEqual({ created: true })
    expect(await isInternalTransferInvoice(hash)).toBe(true)
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
