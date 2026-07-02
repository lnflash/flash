import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import BridgeWithdrawal from "@graphql/public/types/object/bridge-withdrawal"
import { BridgeConfig } from "@config"
import { BridgeDisabledError } from "@services/bridge/errors"
import * as BridgeAccountsRepo from "@services/mongoose/bridge-accounts"
import { presentBridgeWithdrawal } from "@services/bridge/withdrawal-fees"
import { RepositoryError } from "@domain/errors"

const bridgeWithdrawalRequest = GT.Field({
  type: BridgeWithdrawal,
  args: {
    id: { type: GT.NonNull(GT.ID) },
  },
  resolve: async (_, args, { domainAccount }: GraphQLPublicContextAuth) => {
    if (!BridgeConfig.enabled) {
      throw mapAndParseErrorForGqlResponse(new BridgeDisabledError())
    }

    if (!domainAccount) return null

    const withdrawal = await BridgeAccountsRepo.findWithdrawalById(args.id)
    if (withdrawal instanceof RepositoryError) return null

    // Ownership check — never expose another account's withdrawal
    if (withdrawal.accountId !== (domainAccount.id as string)) return null

    return presentBridgeWithdrawal(withdrawal)
  },
})

export default bridgeWithdrawalRequest
