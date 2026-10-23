import { Accounts } from "@app"
import { InvalidWalletForAccountError } from "@domain/accounts"
import { mapError } from "@graphql/error-map"

// Both public account types expose this field. Bind it to the authenticated
// account before considering caller-supplied wallet IDs, then let the app
// service validate the entire requested subset against stored ownership.
export const exportOwnedAccountCSV = async (
  source: Account,
  walletIds: WalletId[],
  context: GraphQLPublicContextAuth,
): Promise<string> => {
  if (!context.domainAccount || context.domainAccount.id !== source.id)
    throw mapError(new InvalidWalletForAccountError())

  const result = await Accounts.getCSVForAccount(source.id, walletIds)
  if (result instanceof Error) throw mapError(result)
  return result
}
