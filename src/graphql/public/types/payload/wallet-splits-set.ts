import { GT } from "@graphql/index"
import IError from "@graphql/shared/types/abstract/error"
import WalletSplit from "@graphql/shared/types/object/wallet-split"

const WalletSplitsSetPayload = GT.Object({
  name: "WalletSplitsSetPayload",
  fields: () => ({
    errors: {
      type: GT.NonNullList(IError),
    },
    splits: {
      type: GT.List(GT.NonNull(WalletSplit)),
    },
  }),
})

export default WalletSplitsSetPayload
