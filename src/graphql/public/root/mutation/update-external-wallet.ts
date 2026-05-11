import { Accounts } from "@app/index";
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map";
import { GT } from "@graphql/index";
import UpdateExternalWalletPayload from "@graphql/public/types/payload/update-external-wallet";
import Lnurl from "@graphql/shared/types/scalar/lnurl";

const UpdateExternalWalletInput = GT.Input({
    name: "UpdateExternalWalletInput",
    fields: () => ({
        lnurlp: { type: GT.NonNull(Lnurl) }
    })
})


const UpdateExternalWalletMutation = GT.Field({
    extensions: { complexity: 120 },
    type: GT.NonNull(UpdateExternalWalletPayload),
    args: {
        input: { type: GT.NonNull(UpdateExternalWalletInput) }
    },
    resolve: async (_, args, { domainAccount }: { domainAccount: Account }) => {
        const { lnurlp } = args.input

        if (lnurlp instanceof Error) {
            return {
                errors: [{ message: lnurlp.message }],
                walletId: null
            }
        }

        const wallet = await Accounts.updateExternalWallet({ accountId: domainAccount.id, lnurlp });

        if (wallet instanceof Error) {
            return {
                errors: [mapAndParseErrorForGqlResponse(wallet)],
                walletId: null
            }
        }

        return {
            errors: [],
            walletId: wallet.id
        }
    }
})


export default UpdateExternalWalletMutation