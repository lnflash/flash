import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import CashWalletCutoverPayload from "@graphql/admin/types/payload/cash-wallet-cutover"
import CashWalletCutoverState from "@graphql/shared/types/scalar/cash-wallet-cutover-state"
import Timestamp from "@graphql/shared/types/scalar/timestamp"
import { CashWalletCutoverRepository } from "@services/mongoose/cash-wallet-cutover"

const CashWalletCutoverUpdateInput = GT.Input({
  name: "CashWalletCutoverUpdateInput",
  fields: () => ({
    state: { type: GT.NonNull(CashWalletCutoverState) },
    scheduledAt: { type: Timestamp },
    cutoverVersion: { type: GT.Int },
    runId: { type: GT.String },
    pauseReason: { type: GT.String },
  }),
})

const CashWalletCutoverUpdateMutation = GT.Field<
  null,
  GraphQLAdminContext,
  {
    input: {
      state: CashWalletCutoverState | Error
      scheduledAt?: Date | Error
      cutoverVersion?: number
      runId?: string
      pauseReason?: string
    }
  }
>({
  type: GT.NonNull(CashWalletCutoverPayload),
  args: {
    input: { type: GT.NonNull(CashWalletCutoverUpdateInput) },
  },
  resolve: async (_, { input }, ctx) => {
    if (input.state instanceof Error) {
      return { errors: [{ message: input.state.message }] }
    }
    if (input.scheduledAt instanceof Error) {
      return { errors: [{ message: input.scheduledAt.message }] }
    }

    const patch: Partial<CashWalletCutoverConfig> = {
      state: input.state,
      scheduledAt: input.scheduledAt,
      cutoverVersion: input.cutoverVersion,
      runId: input.runId,
      pauseReason: input.pauseReason,
    }

    const result = await CashWalletCutoverRepository().updateConfig(patch, ctx.user.id)
    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }

    return { errors: [], cashWalletCutover: result }
  },
})

export default CashWalletCutoverUpdateMutation
