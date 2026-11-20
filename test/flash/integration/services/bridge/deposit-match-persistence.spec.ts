/**
 * ENG-891: the hourly deposit matcher and the IBEX receive path rest on two
 * Mongo behaviours every unit spec mocks, so these run against the real
 * collections:
 *
 *  - a receive counts as processed only once markIbexCryptoReceiveProcessed
 *    ran (a receive whose steps failed half way is retried), and the processed
 *    lookup matches a tx hash whatever its letter case;
 *  - upsertBridgeReconciliationOrphan reports `created` only the first time,
 *    which is what keeps the hourly deposit check from alerting every run.
 */
import crypto from "crypto"

import { upsertBridgeReconciliationOrphan } from "@services/mongoose/bridge-reconciliation-orphan"
import {
  createIbexCryptoReceive,
  findProcessedIbexCryptoReceiveTxHashes,
  isIbexCryptoReceiveProcessed,
  markIbexCryptoReceiveProcessed,
} from "@services/mongoose/ibex-crypto-receive-log"
import { BridgeReconciliationOrphan, IbexCryptoReceive } from "@services/mongoose/schema"

const randomHash = () => `0x${crypto.randomBytes(32).toString("hex")}`

const receive = (txHash: string) => ({
  txHash,
  address: "0xdeposit",
  amount: "489.51",
  currency: "USDT",
  network: "ethereum",
  accountId: "account-1",
  ibexTransactionId: "ibex-tx-1",
})

describe("IBEX crypto receive processed state", () => {
  const hashes: string[] = []
  const newHash = () => {
    const hash = randomHash()
    hashes.push(hash)
    return hash
  }

  afterAll(async () => {
    await IbexCryptoReceive.deleteMany({ txHash: { $in: hashes } })
  })

  it("is not processed until marked, and is after", async () => {
    const txHash = newHash()
    expect(await createIbexCryptoReceive(receive(txHash))).not.toBeInstanceOf(Error)

    expect(await isIbexCryptoReceiveProcessed(txHash)).toBe(false)
    expect(await markIbexCryptoReceiveProcessed(txHash)).toBe(true)
    expect(await isIbexCryptoReceiveProcessed(txHash)).toBe(true)

    const stored = await IbexCryptoReceive.findOne({ txHash }).lean()
    expect(stored?.ibexTransactionId).toBe("ibex-tx-1")
    expect(stored?.processedAt).toBeInstanceOf(Date)
  })

  it("keeps the processed mark when the receive is written again", async () => {
    const txHash = newHash()
    await createIbexCryptoReceive(receive(txHash))
    await markIbexCryptoReceiveProcessed(txHash)

    await createIbexCryptoReceive(receive(txHash))

    expect(await isIbexCryptoReceiveProcessed(txHash)).toBe(true)
  })

  it("reports a never-seen tx hash as not processed", async () => {
    expect(await isIbexCryptoReceiveProcessed(randomHash())).toBe(false)
  })

  it("finds processed hashes whatever their letter case, and skips unprocessed ones", async () => {
    const processed = newHash()
    const unprocessed = newHash()
    await createIbexCryptoReceive(receive(processed))
    await markIbexCryptoReceiveProcessed(processed)
    await createIbexCryptoReceive(receive(unprocessed))

    const found = await findProcessedIbexCryptoReceiveTxHashes([
      processed.toUpperCase().replace("0X", "0x"),
      unprocessed,
      randomHash(),
    ])

    expect(found).toEqual(new Set([processed.toLowerCase()]))
  })

  it("returns an empty set for no hashes", async () => {
    expect(await findProcessedIbexCryptoReceiveTxHashes([])).toEqual(new Set())
  })
})

describe("Bridge reconciliation orphan upsert", () => {
  const keys: string[] = []

  afterAll(async () => {
    await BridgeReconciliationOrphan.deleteMany({ orphanKey: { $in: keys } })
  })

  it("reports created only the first time an orphan is stored", async () => {
    const txHash = randomHash()
    const orphanKey = `bridge:${txHash}`
    keys.push(orphanKey)
    const data = {
      orphanKey,
      orphanType: "bridge_without_ibex" as const,
      txHash,
      transferId: "deposit-1",
      triageContext: { reason: "test" },
    }

    const first = await upsertBridgeReconciliationOrphan(data)
    const second = await upsertBridgeReconciliationOrphan(data)

    expect(first).toEqual(expect.objectContaining({ created: true }))
    expect(second).toEqual(expect.objectContaining({ created: false }))
    if (first instanceof Error || second instanceof Error) return
    expect(second.id).toBe(first.id)
    expect(await BridgeReconciliationOrphan.countDocuments({ orphanKey })).toBe(1)
  })
})
