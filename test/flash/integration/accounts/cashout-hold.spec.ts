/**
 * ENG-889: the cash-out hold and the Bridge customer status store both rest on
 * filter-shaped Mongo writes, and every unit spec mocks the model, so a wrong
 * filter would leave a guard silently inert while the unit suite stays green
 * (the reason npub.spec.ts exists). These run against the real collections:
 *
 *  - placeCashoutHold's `cashoutHold: { $eq: null }` matches both a missing
 *    field and an explicit null, and never overwrites a hold already there;
 *  - the `$push` onto cashoutHoldHistory, whose schema default is undefined,
 *    creates the array and appends to it;
 *  - releaseCashoutHold's `cashoutHold: { $ne: null }` + `$unset` clears the
 *    hold once, and a second release is refused;
 *  - recordCustomerStatusChange only applies against the status the run read,
 *    and the first-seen upsert inserts once;
 *  - the seed's baseline marker is written and read back, and kept out of the
 *    statuses.
 */
import crypto from "crypto"

import mongoose from "mongoose"

import {
  CouldNotFindAccountFromIdError,
  NoCashoutHoldToReleaseError,
} from "@domain/errors"
import { AccountsRepository } from "@services/mongoose"
import {
  BASELINE_COMPLETE_MARKER_ID,
  loadCustomerStatuses,
  recordCustomerStatusChange,
  seedCustomerStatuses,
} from "@services/mongoose/bridge-customer-status"
import { Account as AccountModel, BridgeCustomerStatus } from "@services/mongoose/schema"
import { toObjectId } from "@services/mongoose/utils"

const ADMIN_USER_ID = "ops-user-id" as UserId

// Written straight to the collection: these specs are about the repository's
// filters, not account creation, so nothing else (Kratos, IBEX) is involved.
const newAccountId = async (): Promise<AccountId> => {
  const doc = await AccountModel.create({ kratosUserId: crypto.randomUUID() })
  return doc._id.toString() as AccountId
}

// A well-formed id no account has.
const unknownId = (): AccountId => new mongoose.Types.ObjectId().toString() as AccountId

const rawAccount = async (accountId: AccountId) =>
  AccountModel.collection.findOne({ _id: toObjectId<AccountId>(accountId) })

const hold = (reason: string): AccountCashoutHold => ({
  reason,
  source: "bridge-customer-status",
  setAt: new Date(),
})

const place = async (accountId: AccountId, reason: string) => {
  const result = await AccountsRepository().placeCashoutHold(accountId, hold(reason))
  if (result instanceof Error) throw result
  return result
}

describe("cash-out hold persistence", () => {
  it("places a hold on an account with no cashoutHold field", async () => {
    const accountId = await newAccountId()
    expect(await rawAccount(accountId)).not.toHaveProperty("cashoutHold")

    const result = await place(accountId, "first")

    expect(result.placed).toBe(true)
    expect(result.account.cashoutHold?.reason).toBe("first")
    const doc = await rawAccount(accountId)
    expect(doc?.cashoutHold?.reason).toBe("first")
    expect(doc?.cashoutHoldHistory).toHaveLength(1)
    expect(doc?.cashoutHoldHistory[0]).toEqual(
      expect.objectContaining({ action: "placed", reason: "first" }),
    )
  })

  it("places a hold on an account with an explicit cashoutHold: null", async () => {
    const accountId = await newAccountId()
    await AccountModel.collection.updateOne(
      { _id: toObjectId<AccountId>(accountId) },
      { $set: { cashoutHold: null } },
    )

    const result = await place(accountId, "over null")

    expect(result.placed).toBe(true)
    expect((await rawAccount(accountId))?.cashoutHold?.reason).toBe("over null")
  })

  it("leaves the first hold and a single history entry on a second place", async () => {
    const accountId = await newAccountId()
    await place(accountId, "first")

    const second = await place(accountId, "second")

    expect(second.placed).toBe(false)
    expect(second.account.cashoutHold?.reason).toBe("first")
    const doc = await rawAccount(accountId)
    expect(doc?.cashoutHold?.reason).toBe("first")
    expect(doc?.cashoutHoldHistory).toHaveLength(1)
  })

  it("returns CouldNotFindAccountFromIdError for an unknown account", async () => {
    const result = await AccountsRepository().placeCashoutHold(unknownId(), hold("x"))

    expect(result).toBeInstanceOf(CouldNotFindAccountFromIdError)
  })

  it("releases once: unsets the hold and records who released it", async () => {
    const accountId = await newAccountId()
    await place(accountId, "first")

    const released = await AccountsRepository().releaseCashoutHold(accountId, {
      releasedByUserId: ADMIN_USER_ID,
      comment: "reviewed",
    })
    if (released instanceof Error) throw released

    expect(released.previousHold.reason).toBe("first")
    expect(released.account.cashoutHold).toBeUndefined()
    const doc = await rawAccount(accountId)
    expect(doc).not.toHaveProperty("cashoutHold")
    expect(doc?.cashoutHoldHistory).toHaveLength(2)
    expect(doc?.cashoutHoldHistory[1]).toEqual(
      expect.objectContaining({
        action: "released",
        byUserId: ADMIN_USER_ID,
        comment: "reviewed",
      }),
    )

    const again = await AccountsRepository().releaseCashoutHold(accountId, {
      releasedByUserId: ADMIN_USER_ID,
    })
    expect(again).toBeInstanceOf(NoCashoutHoldToReleaseError)
    expect((await rawAccount(accountId))?.cashoutHoldHistory).toHaveLength(2)
  })

  it("places a fresh hold after a release", async () => {
    const accountId = await newAccountId()
    await place(accountId, "first")
    await AccountsRepository().releaseCashoutHold(accountId, {
      releasedByUserId: ADMIN_USER_ID,
    })

    const result = await place(accountId, "again")

    expect(result.placed).toBe(true)
    expect((await rawAccount(accountId))?.cashoutHoldHistory).toHaveLength(3)
  })

  it("refuses to release on an unknown account", async () => {
    const result = await AccountsRepository().releaseCashoutHold(unknownId(), {
      releasedByUserId: ADMIN_USER_ID,
    })

    expect(result).toBeInstanceOf(CouldNotFindAccountFromIdError)
  })
})

describe("Bridge customer status persistence", () => {
  const newCustomerId = () => `cust_it_${crypto.randomUUID()}`

  const storedStatus = async (customerId: string) =>
    BridgeCustomerStatus.collection.findOne({ customerId })

  it("inserts a first-seen customer once; a second call is not applied", async () => {
    const customerId = newCustomerId()

    const first = await recordCustomerStatusChange({ customerId, to: "offboarded" })
    const second = await recordCustomerStatusChange({ customerId, to: "active" })

    expect(first).toEqual({ applied: true })
    expect(second).toEqual({ applied: false })
    expect((await storedStatus(customerId))?.status).toBe("offboarded")
    expect(await BridgeCustomerStatus.countDocuments({ customerId })).toBe(1)
  })

  it("applies a change only when the stored status equals `from`", async () => {
    const customerId = newCustomerId()
    await recordCustomerStatusChange({ customerId, to: "active" })

    const stale = await recordCustomerStatusChange({
      customerId,
      from: "paused",
      to: "offboarded",
    })
    expect(stale).toEqual({ applied: false })
    expect((await storedStatus(customerId))?.status).toBe("active")

    const current = await recordCustomerStatusChange({
      customerId,
      from: "active",
      to: "deposits_restricted",
      accountId: "acct_it",
    })
    expect(current).toEqual({ applied: true })
    const doc = await storedStatus(customerId)
    expect(doc?.status).toBe("deposits_restricted")
    expect(doc?.previousStatus).toBe("active")
    expect(doc?.accountId).toBe("acct_it")
  })

  it("seeds insert-if-absent, writes the baseline marker, and keeps it out of the statuses", async () => {
    const kept = newCustomerId()
    const fresh = newCustomerId()
    await recordCustomerStatusChange({ customerId: kept, to: "paused" })

    expect(
      await seedCustomerStatuses([
        { customerId: kept, status: "active" },
        { customerId: fresh, status: "offboarded" },
      ]),
    ).toBe(true)

    expect((await storedStatus(kept))?.status).toBe("paused")
    expect((await storedStatus(fresh))?.status).toBe("offboarded")
    expect(
      await BridgeCustomerStatus.countDocuments({
        customerId: BASELINE_COMPLETE_MARKER_ID,
      }),
    ).toBe(1)

    // A second seed adds no second marker.
    expect(await seedCustomerStatuses([])).toBe(true)
    expect(
      await BridgeCustomerStatus.countDocuments({
        customerId: BASELINE_COMPLETE_MARKER_ID,
      }),
    ).toBe(1)

    const loaded = await loadCustomerStatuses()
    if (loaded instanceof Error) throw loaded
    expect(loaded.baselineComplete).toBe(true)
    expect(loaded.statuses.has(BASELINE_COMPLETE_MARKER_ID)).toBe(false)
    expect(loaded.statuses.get(fresh)?.status).toBe("offboarded")
  })
})
