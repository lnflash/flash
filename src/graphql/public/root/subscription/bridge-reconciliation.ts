import { GT } from "@graphql/index"
import BridgeReconciliationEvent from "@graphql/public/types/object/bridge-reconciliation-event"
import IError from "@graphql/shared/types/abstract/error"
import { AuthenticationError } from "@graphql/error"
import { baseLogger } from "@services/logger"
import { PubSubService } from "@services/pubsub"
import { PubSubDefaultTriggers } from "@domain/pubsub"

const pubsub = PubSubService()

const BridgeReconciliationPayload = GT.Object({
  name: "BridgeReconciliationPayload",
  fields: () => ({
    errors: { type: GT.NonNullList(IError) },
    event: { type: BridgeReconciliationEvent },
  }),
})

type ReconciliationEventPayload = {
  txHash: string
  status: "matched" | "unmatched"
  orphanType?: string
  transferId?: string
  customerId?: string
  amount?: string
  currency?: string
  detectedAt: Date
}

const BridgeReconciliationSubscription = {
  type: GT.NonNull(BridgeReconciliationPayload),

  resolve: (rawSource: unknown) => {
    const source = rawSource as ReconciliationEventPayload | undefined
    if (!source) {
      return { errors: [{ message: "No reconciliation event received" }], event: null }
    }
    return {
      errors: [],
      event: {
        txHash: source.txHash,
        status: source.status,
        orphanType: source.orphanType ?? null,
        transferId: source.transferId ?? null,
        customerId: source.customerId ?? null,
        amount: source.amount ?? null,
        currency: source.currency ?? null,
        detectedAt:
          source.detectedAt instanceof Date
            ? source.detectedAt.toISOString()
            : String(source.detectedAt),
      },
    }
  },

  subscribe: (_source: unknown, _args: unknown, ctx: GraphQLPublicContextAuth) => {
    if (!ctx.domainAccount) {
      throw new AuthenticationError({
        message: "Not authenticated for bridge reconciliation subscription",
        logger: baseLogger,
      })
    }

    return pubsub.createAsyncIterator({
      trigger: PubSubDefaultTriggers.BridgeReconciliationUpdate,
    })
  },
}

export default BridgeReconciliationSubscription
