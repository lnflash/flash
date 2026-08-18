import { getFygaroTopupAllowance } from "@app/fygaro/topup-allowance"
import { GT } from "@graphql/index"
import FygaroTopupAllowance from "@graphql/public/types/object/fygaro-topup-allowance"

const FygaroTopupAllowanceQuery = GT.Field({
  type: FygaroTopupAllowance,
  description:
    "How much card top-up allowance this account has left today. Null when the " +
    "allowance cannot currently be established — show the flat limit and let the " +
    "pre-charge check decide, rather than inventing a number.",
  resolve: async (_, __, { domainAccount }: GraphQLPublicContextAuth) => {
    const result = await getFygaroTopupAllowance({
      accountId: domainAccount.id,
      level: domainAccount.level,
    })
    // Null rather than an error: this is decoration on a screen the customer is
    // still filling in, and a red banner over an ERPNext blip would be worse
    // than simply not showing the number. Nothing is authorised here — the
    // real gate still runs before any charge.
    if (!result.available) return null

    const { limitCents, spentCents, remainingCents, resetsAt } = result.allowance
    return { limit: limitCents, spent: spentCents, remaining: remainingCents, resetsAt }
  },
})

export default FygaroTopupAllowanceQuery
