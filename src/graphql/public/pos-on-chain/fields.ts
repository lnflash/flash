import { GT } from "@graphql/index"
import { CheckoutError, checkoutService } from "@app/pos-on-chain/checkout"

const string = GT.NonNull(GT.String)
const number = GT.NonNull(GT.Float)
const network = GT.Enum({
  name: "PosOnChainNetwork",
  values: { MAINNET: {}, TESTNET: {}, SIGNET: {}, REGTEST: {} },
})
const status = GT.Enum({
  name: "PosOnChainPaymentStatus",
  values: { AWAITING_PAYMENT: {}, PENDING: {}, CONFIRMED: {} },
})
const checkout = GT.Object({
  name: "PosOnChainCheckout",
  fields: () => ({
    id: { type: string },
    recipientWalletId: { type: string },
    address: { type: string },
    network: { type: GT.NonNull(network) },
    status: { type: GT.NonNull(status) },
    sats: { type: number },
    receivedSats: { type: number },
    confirmedSats: { type: number },
  }),
})
const issue = GT.Object({
  name: "PosOnChainCheckoutError",
  fields: () => ({ message: { type: string } }),
})
const payload = GT.NonNull(
  GT.Object({
    name: "PosOnChainCheckoutPayload",
    fields: () => ({
      checkout: { type: checkout },
      errors: { type: GT.NonNullList(issue) },
    }),
  }),
)
const input = GT.Input({
  name: "PosOnChainCheckoutCreateInput",
  fields: () => ({
    recipientWalletId: { type: string },
    requestId: { type: string },
    sats: { type: number },
  }),
})

type Operation = "supported" | "create" | "status"

export function posOnChainFields(
  getService: () => ReturnType<typeof checkoutService> | null,
  limitRequest: (ip: string, operation: Operation) => Promise<void>,
) {
  async function limitedService(ctx: GraphQLPublicContext, operation: Operation) {
    await limitRequest(ctx?.ip || "unknown", operation)
    return getService()
  }

  async function run(
    ctx: GraphQLPublicContext,
    operation: "create" | "status",
    action: (
      svc: ReturnType<typeof checkoutService>,
    ) => ReturnType<ReturnType<typeof checkoutService>["status"]>,
  ) {
    try {
      const svc = await limitedService(ctx, operation)
      if (!svc) throw new CheckoutError("On-chain checkout is unavailable.")
      return { checkout: await action(svc), errors: [] }
    } catch (err) {
      return {
        checkout: null,
        errors: [
          {
            message:
              err instanceof CheckoutError
                ? err.message
                : "Could not verify this checkout. Retry the same sale.",
          },
        ],
      }
    }
  }
  return {
    supported: GT.Field({
      type: GT.NonNull(GT.Boolean),
      args: { recipientWalletId: { type: GT.String } },
      resolve: async (_, args, ctx: GraphQLPublicContext) =>
        (await limitedService(ctx, "supported"))?.supports(args.recipientWalletId) ??
        false,
    }),
    create: GT.Field({
      type: payload,
      extensions: { complexity: 120 },
      args: { input: { type: GT.NonNull(input) } },
      resolve: (_, args, ctx: GraphQLPublicContext) =>
        run(ctx, "create", (svc) => svc.create(args.input)),
    }),
    status: GT.Field({
      type: payload,
      extensions: { complexity: 100 },
      args: { id: { type: string } },
      resolve: (_, args, ctx: GraphQLPublicContext) =>
        run(ctx, "status", (svc) => svc.status(args.id)),
    }),
  }
}
