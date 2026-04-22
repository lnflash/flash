import { setLnurlp } from "@app/accounts/update-account-lnurlp"

import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"

import AccountUpdateLnurlpPayload from "@graphql/public/types/payload/account-update-lnurlp"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import { Accounts } from "@app/index"

const AccountSetLnurlpInput = GT.Input({
    name: "AccountSetLnurlpInput",
    fields: () => ({
        lnurl: { type: GT.NonNull(GT.String) },
        walletId: { type: WalletId },
    }),
})

const AccountSetLnurlpMutation = GT.Field({
    extensions: { complexity: 1 },
    type: GT.NonNull(AccountUpdateLnurlpPayload),
    args: {
        input: { type: GT.NonNull(AccountSetLnurlpInput) },
    },
    resolve: async (_, args, { domainAccount }: { domainAccount: Account }) => {
        const { input } = args
        const { lnurl, walletId } = input
        const account = await Accounts.setLnurlp({ accountId: domainAccount.id, lnurl, walletId })
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

export default AccountSetLnurlpMutation
