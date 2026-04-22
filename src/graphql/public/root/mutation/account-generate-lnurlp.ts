import { generateLnurlp } from "@app/accounts/update-account-lnurlp"

import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"

import AccountUpdateLnurlpPayload from "@graphql/public/types/payload/account-update-lnurlp"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import { Accounts } from "@app/index"

const AccountGenerateLnurlpInput = GT.Input({
    name: "AccountGenerateLnurlpInput",
    fields: () => ({
        walletId: { type: GT.NonNull(WalletId) },
    }),
})

const AccountGenerateLnurlpMutation = GT.Field({
    extensions: { complexity: 1 },
    type: GT.NonNull(AccountUpdateLnurlpPayload),
    args: {
        input: { type: GT.NonNull(AccountGenerateLnurlpInput) },
    },
    resolve: async (_, args, { domainAccount }: { domainAccount: Account }) => {
        const { input } = args
        const { walletId } = input
        const account = await Accounts.generateLnurlp({ accountId: domainAccount.id, walletId })
        if (account instanceof Error) {
            return {
                errors: [mapAndParseErrorForGqlResponse(account)],
                account: null,
            }
        }
        return {
            errors: [],
            account,
        }
    },
})

export default AccountGenerateLnurlpMutation
