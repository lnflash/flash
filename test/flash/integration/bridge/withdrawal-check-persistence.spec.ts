/**
 * ENG-891: the hourly withdrawal check deletes a send_failed withdrawal's
 * Bridge transfer once, then records it with markSendFailedTransferCancelled
 * so later runs skip it. Unit specs mock the model; this runs the filter
 * against the real collection:
 *
 *  - only a send_failed withdrawal with that transfer id is marked;
 *  - the check's own query no longer returns it once marked.
 */
import crypto from "crypto"

import { toBridgeTransferId } from "@domain/primitives/bridge"
import { markSendFailedTransferCancelled } from "@services/mongoose/bridge-accounts"
import { BridgeWithdrawal } from "@services/mongoose/schema"

const withdrawal = (status: string, bridgeTransferId: string) => ({
  accountId: `account-${crypto.randomBytes(6).toString("hex")}`,
  bridgeTransferId,
  amount: "25.00",
  currency: "usdt",
  status,
  flashFeePercent: "0",
  flashFee: "0",
  estimatedBridgeFeePercent: "0",
  estimatedBridgeFee: "0",
  estimatedGasBuffer: "0",
  estimatedCustomerFee: "0",
  externalAccountId: "external-1",
})

const inFlightQuery = (bridgeTransferId: string) => ({
  bridgeTransferId,
  status: { $in: ["usdt_sent", "send_failed"] },
  bridgeTransferCancelledAt: { $exists: false },
})

describe("markSendFailedTransferCancelled", () => {
  const transferIds: string[] = []
  const newTransferId = () => {
    const id = `tr_${crypto.randomBytes(8).toString("hex")}`
    transferIds.push(id)
    return id
  }

  afterAll(async () => {
    await BridgeWithdrawal.deleteMany({ bridgeTransferId: { $in: transferIds } })
  })

  it("marks a send_failed withdrawal so the check stops reading it", async () => {
    const transferId = newTransferId()
    await BridgeWithdrawal.create(withdrawal("send_failed", transferId))
    expect(await BridgeWithdrawal.countDocuments(inFlightQuery(transferId))).toBe(1)

    expect(await markSendFailedTransferCancelled(toBridgeTransferId(transferId))).toBe(
      true,
    )

    const stored = await BridgeWithdrawal.findOne({ bridgeTransferId: transferId }).lean()
    expect(stored?.status).toBe("send_failed")
    expect(stored?.bridgeTransferCancelledAt).toBeInstanceOf(Date)
    expect(await BridgeWithdrawal.countDocuments(inFlightQuery(transferId))).toBe(0)
  })

  it("leaves a withdrawal in any other status untouched", async () => {
    const transferId = newTransferId()
    await BridgeWithdrawal.create(withdrawal("usdt_sent", transferId))

    await markSendFailedTransferCancelled(toBridgeTransferId(transferId))

    const stored = await BridgeWithdrawal.findOne({ bridgeTransferId: transferId }).lean()
    expect(stored?.bridgeTransferCancelledAt).toBeUndefined()
    expect(await BridgeWithdrawal.countDocuments(inFlightQuery(transferId))).toBe(1)
  })
})
