import { BridgeCustomerStatus } from "./schema"

// ENG-889: the last Bridge customer status the hourly watcher saw, per Bridge
// customer.

export type BridgeCustomerStatusRecord = {
  customerId: string
  status: string
  previousStatus?: string
  accountId?: string
  firstSeenAt?: Date
  statusChangedAt?: Date
}

const SEED_BATCH = 500

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error))

// Written once the first run's seed has fully landed. "First run" is decided by
// this marker, never by an empty collection: a seed that wrote some batches and
// then failed leaves a non-empty store, and reading that as a completed
// baseline would alert on (and hold) every customer the seed never reached.
// Stored in the same collection under an id Bridge never issues.
export const BASELINE_COMPLETE_MARKER_ID = "__baseline_complete__"

export type StoredCustomerStatuses = {
  statuses: Map<string, BridgeCustomerStatusRecord>
  // False until a seed has written every customer and then the marker.
  baselineComplete: boolean
}

// Every stored status, keyed by Bridge customer id, without the marker. One
// small document per customer, so the whole set is read once per run.
export const loadCustomerStatuses = async (): Promise<StoredCustomerStatuses | Error> => {
  try {
    const records = (await BridgeCustomerStatus.find(
      {},
      { _id: 0, customerId: 1, status: 1, previousStatus: 1, accountId: 1 },
    )
      .lean()
      .exec()) as unknown as BridgeCustomerStatusRecord[]
    let baselineComplete = false
    const statuses = new Map<string, BridgeCustomerStatusRecord>()
    for (const record of records) {
      if (record.customerId === BASELINE_COMPLETE_MARKER_ID) baselineComplete = true
      else statuses.set(record.customerId, record)
    }
    return { statuses, baselineComplete }
  } catch (error) {
    return toError(error)
  }
}

// The first run's baseline. Insert-if-absent, so a seed that races another run
// (or is retried after a partial failure) never overwrites a status already
// recorded. The marker is written only after every batch has landed, so `true`
// means the baseline is complete.
export const seedCustomerStatuses = async (
  customers: { customerId: string; status: string }[],
): Promise<true | Error> => {
  try {
    const now = new Date()
    for (let i = 0; i < customers.length; i += SEED_BATCH) {
      await BridgeCustomerStatus.bulkWrite(
        customers.slice(i, i + SEED_BATCH).map(({ customerId, status }) => ({
          updateOne: {
            filter: { customerId: { $eq: customerId } },
            update: {
              $setOnInsert: {
                customerId,
                status,
                firstSeenAt: now,
                statusChangedAt: now,
                updatedAt: now,
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      )
    }
    await BridgeCustomerStatus.updateOne(
      { customerId: { $eq: BASELINE_COMPLETE_MARKER_ID } },
      {
        $setOnInsert: {
          customerId: BASELINE_COMPLETE_MARKER_ID,
          status: "baseline",
          firstSeenAt: now,
          statusChangedAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    )
    return true
  } catch (error) {
    return toError(error)
  }
}

// Records a status change seen by this run. `from` is the status this run read
// from the store (undefined for a customer never seen before), and the write
// only lands if the store still holds it, so two overlapping runs cannot leave
// the record out of step with what Bridge reported. `applied` is false when
// another run recorded it first.
export const recordCustomerStatusChange = async ({
  customerId,
  from,
  to,
  accountId,
}: {
  customerId: string
  from?: string
  to: string
  accountId?: string
}): Promise<{ applied: boolean } | Error> => {
  const now = new Date()
  try {
    if (from === undefined) {
      const result = await BridgeCustomerStatus.updateOne(
        { customerId: { $eq: customerId } },
        {
          $setOnInsert: {
            customerId,
            status: to,
            ...(accountId ? { accountId } : {}),
            firstSeenAt: now,
            statusChangedAt: now,
            updatedAt: now,
          },
        },
        { upsert: true },
      )
      return { applied: result.upsertedCount === 1 }
    }

    const result = await BridgeCustomerStatus.updateOne(
      { customerId: { $eq: customerId }, status: { $eq: from } },
      {
        $set: {
          status: to,
          previousStatus: from,
          ...(accountId ? { accountId } : {}),
          statusChangedAt: now,
          updatedAt: now,
        },
      },
    )
    return { applied: result.modifiedCount === 1 }
  } catch (error) {
    return toError(error)
  }
}
