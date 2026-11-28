import { UsdtCheckoutError, usdtCheckoutService } from "@app/pos-usdt-checkout/checkout"
import { GT } from "@graphql/index"
import WalletId from "@graphql/shared/types/scalar/wallet-id"

type Service = ReturnType<typeof usdtCheckoutService>
type Operation = "supported" | "create" | "status"

const string = GT.NonNull(GT.String)
const walletId = GT.NonNull(WalletId)
const network = GT.Enum({
  name: "PosUsdtNetwork",
  values: { ETHEREUM: {} },
})
const status = GT.Enum({
  name: "PosUsdtPaymentStatus",
  values: { AWAITING_PAYMENT: {}, DETECTED: {}, PAID: {} },
})
const checkout = GT.Object({
  name: "PosUsdtCheckout",
  fields: () => ({
    id: { type: string },
    recipientWalletId: { type: walletId },
    address: { type: string },
    network: { type: GT.NonNull(network) },
    status: { type: GT.NonNull(status) },
    amountMinor: { type: GT.NonNull(GT.Int) },
  }),
})
const issue = GT.Object({
  name: "PosUsdtCheckoutError",
  fields: () => ({ message: { type: string } }),
})
const payload = GT.NonNull(
  GT.Object({
    name: "PosUsdtCheckoutPayload",
    fields: () => ({
      checkout: { type: checkout },
      errors: { type: GT.NonNullList(issue) },
    }),
  }),
)
const input = GT.Input({
  name: "PosUsdtCheckoutCreateInput",
  fields: () => ({
    recipientWalletId: { type: walletId },
    requestId: { type: string },
    // US cents.
    amountMinor: { type: GT.NonNull(GT.Int) },
  }),
})

export function posUsdtFields(
  getService: () => Service | null,
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
    action: (svc: Service) => ReturnType<Service["status"]>,
  ) {
    try {
      const svc = await limitedService(ctx, operation)
      if (!svc) throw new UsdtCheckoutError("USDT checkout is unavailable.")
      return { checkout: await action(svc), errors: [] }
    } catch (err) {
      return {
        checkout: null,
        errors: [
          {
            // Only messages written for the POS; never an internal error.
            message:
              err instanceof UsdtCheckoutError
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
      args: { recipientWalletId: { type: walletId } },
      resolve: async (_, args, ctx: GraphQLPublicContext) => {
        try {
          const svc = await limitedService(ctx, "supported")
          const { recipientWalletId } = args
          if (!svc || recipientWalletId instanceof Error) return false
          return await svc.supports(recipientWalletId)
        } catch (err) {
          if (err instanceof UsdtCheckoutError) throw err
          return false
        }
      },
    }),
    create: GT.Field({
      type: payload,
      extensions: { complexity: 120 },
      args: { input: { type: GT.NonNull(input) } },
      resolve: (_, args, ctx: GraphQLPublicContext) =>
        run(ctx, "create", async (svc) => {
          const { recipientWalletId, requestId, amountMinor } = args.input
          // Invalid scalars arrive as Error values. Charged to the IP budget first.
          if (recipientWalletId instanceof Error)
            throw new UsdtCheckoutError(recipientWalletId.message)
          return svc.create({ recipientWalletId, requestId, amountMinor }, ipOf(ctx))
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
