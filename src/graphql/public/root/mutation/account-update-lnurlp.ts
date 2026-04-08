import { updateLnurlp } from "@app/accounts/update-account-lnurlp"

import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"

import AccountUpdateLnurlpPayload from "@graphql/public/types/payload/account-update-lnurlp"
import Lnurl from "@graphql/shared/types/scalar/lnurl"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import { Accounts } from "@app/index"

const AccountUpdateLnurlpInput = GT.Input({
    name: "AccountUpdateLnurlpInput",
    fields: () => ({
        lnurlp: { type: GT.String },
        walletId: { type: WalletId },
    }),
})

const AccountUpdateLnurlpMutation = GT.Field({
    extensions: { complexity: 1 },
    type: GT.NonNull(AccountUpdateLnurlpPayload),
    args: {
        input: { type: GT.NonNull(AccountUpdateLnurlpInput) },
    },
    resolve: async (_, args, { domainAccount }: { domainAccount: Account }) => {
        const { input } = args
        const { lnurlp } = input
        const account = await Accounts.updateLnurlp({ accountId: domainAccount.id, lnurlp })
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

export default AccountUpdateLnurlpMutation