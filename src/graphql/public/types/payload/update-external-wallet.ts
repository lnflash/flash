import { GT } from "@graphql/index";
import IError from "@graphql/shared/types/abstract/error";
import WalletId from "@graphql/shared/types/scalar/wallet-id";


const UpdateExternalWalletPayload = GT.Object({
    name: "UpdateExternalWalletPayload",
    fields: () => ({
        errors: { type: GT.NonNullList(IError) },
        walletId: { type: WalletId }
    }),
})

export default UpdateExternalWalletPayload