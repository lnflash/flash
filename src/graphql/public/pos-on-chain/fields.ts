import { CheckoutError, checkoutService } from "@app/pos-on-chain/checkout"
import { GT } from "@graphql/index"
import SatAmount from "@graphql/shared/types/scalar/sat-amount"
import WalletId from "@graphql/shared/types/scalar/wallet-id"

const string = GT.NonNull(GT.String)
const sats = GT.NonNull(SatAmount)
const walletId = GT.NonNull(WalletId)
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
    recipientWalletId: { type: walletId },
    address: { type: string },
    network: { type: GT.NonNull(network) },
    status: { type: GT.NonNull(status) },
    sats: { type: sats },
    receivedSats: { type: sats },
    confirmedSats: { type: sats },
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
    recipientWalletId: { type: walletId },
    requestId: { type: string },
    sats: { type: sats },
  }),
})

type Operation = "supported" | "create" | "status"

export function posOnChainFields(
  getService: () => ReturnType<typeof checkoutService> | null,
  limitRequest: (ip: string, operation: Operation) => Promise<void>,
) {
  const ipOf = (ctx: GraphQLPublicContext) => ctx?.ip || "unknown"
  async function limitedService(ctx: GraphQLPublicContext, operation: Operation) {
    await limitRequest(ipOf(ctx), operation)
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
      args: { recipientWalletId: { type: WalletId } },
      resolve: async (_, args, ctx: GraphQLPublicContext) => {
        const svc = await limitedService(ctx, "supported")
        const { recipientWalletId } = args
        if (!svc || recipientWalletId instanceof Error) return false
        return svc.supports(recipientWalletId)
      },
    }),
    create: GT.Field({
      type: payload,
      extensions: { complexity: 120 },
      args: { input: { type: GT.NonNull(input) } },
      resolve: (_, args, ctx: GraphQLPublicContext) =>
        run(ctx, "create", async (svc) => {
          const { recipientWalletId, requestId, sats } = args.input
          // Invalid scalars arrive as Error values. Charged to the IP budget first.
          for (const value of [recipientWalletId, sats])
            if (value instanceof Error) throw new CheckoutError(value.message)
          return svc.create({ recipientWalletId, requestId, sats }, ipOf(ctx))
        }),
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
