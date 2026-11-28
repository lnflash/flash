import { LiveUpdateError, LiveUpdateService } from "@app/pos-usdt-checkout/live-updates"
import { GT } from "@graphql/index"

const string = GT.NonNull(GT.String)

const action = GT.Enum({
  name: "PosUsdtLiveUpdateAction",
  values: { ENROLL: {}, WITHDRAW: {} },
})
const issue = GT.Object({
  name: "PosUsdtLiveUpdateError",
  fields: () => ({ message: { type: string } }),
})
const payload = GT.NonNull(
  GT.Object({
    name: "PosUsdtLiveUpdateConsentPayload",
    fields: () => ({
      accepted: { type: GT.NonNull(GT.Boolean) },
      errors: { type: GT.NonNullList(issue) },
    }),
  }),
)
// No stage, status or amount: the server only ever sends the checkout's own.
const input = GT.Input({
  name: "PosUsdtLiveUpdateConsentInput",
  fields: () => ({
    action: { type: GT.NonNull(action) },
    // The receipt id posUsdtCheckoutStatus takes.
    receiptId: { type: string },
    // SHA-256("flash.pos.usdt-flight.v1\n" + endpoint + "\n" + receiptId), hex.
    saleKey: { type: string },
    // ActivityKit Activity.id.
    activityId: { type: string },
    // Increases with every request for this activity (rotation, withdrawal).
    tokenSequence: { type: GT.NonNull(GT.Int) },
    // Lowercase hex ActivityKit push token. ENROLL only.
    pushToken: { type: GT.String },
  }),
})

export function posUsdtLiveFields(getService: () => LiveUpdateService | null) {
  return {
    consent: GT.Field({
      type: payload,
      extensions: { complexity: 100 },
      args: { input: { type: GT.NonNull(input) } },
      resolve: async (_, args, ctx: GraphQLPublicContext) => {
        try {
          const svc = getService()
          if (!svc) throw new LiveUpdateError("Live updates are unavailable.")
          await svc.consent(args.input as never, ctx?.ip || "unknown")
          return { accepted: true, errors: [] }
        } catch (err) {
          return {
            accepted: false,
            errors: [
              {
                // Only messages written for the app; never an internal error.
                message:
                  err instanceof LiveUpdateError
                    ? err.message
                    : "Live updates are temporarily unavailable.",
              },
            ],
          }
        }
      },
    }),
  }
}
