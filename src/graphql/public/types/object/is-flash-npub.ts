import { GT } from "@graphql/index"
import IError from "../../../shared/types/abstract/error"
import Npub from "@graphql/shared/types/scalar/npub"

const IsFlashNpubInput = GT.Input({
  name: "IsFlashNpubInput",
  fields: () => ({
    npub: { type: GT.NonNull(Npub) },
  }),
})

const IsFlashNpubPayload = GT.Object({
  name: "IsFlashNpubPayload",
  fields: () => ({
    errors: {
      type: GT.NonNullList(IError),
    },
    isFlashNpub: { type: GT.Boolean },
  }),
})

export { IsFlashNpubInput, IsFlashNpubPayload }
