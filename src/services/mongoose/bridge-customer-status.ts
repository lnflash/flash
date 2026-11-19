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

// Every stored status, keyed by Bridge customer id. One small document per
// customer, so the whole set is read once per run.
export const loadCustomerStatuses = async (): Promise<
  Map<string, BridgeCustomerStatusRecord> | Error
> => {
  try {
    const records = (await BridgeCustomerStatus.find(
      {},
      { _id: 0, customerId: 1, status: 1, previousStatus: 1, accountId: 1 },
    )
      .lean()
      .exec()) as unknown as BridgeCustomerStatusRecord[]
    return new Map(records.map((record) => [record.customerId, record]))
  } catch (error) {
    return toError(error)
  }
}

// The first run's baseline. Insert-if-absent, so a seed that races another run
// (or is retried) never overwrites a status already recorded.
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
