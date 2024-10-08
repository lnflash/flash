import { GT } from "@graphql/index"
import { Accounts } from "@app"
import {
  IsFlashNpubInput,
  IsFlashNpubPayload,
} from "@graphql/public/types/object/is-flash-npub"
import Npub from "@graphql/shared/types/scalar/npub"

const IsFlashNpubQuery = GT.Field({
  type: IsFlashNpubPayload,
  args: {
    input: {
      type: GT.NonNull(IsFlashNpubInput),
    },
  },
  resolve: async (_, args) => {
    const {
      input: { npub },
    } = args
    if (npub instanceof Error) {
      throw npub
    }
    const output = await Accounts.findByNpub(npub)
    console.log("output is", output)
    if (output instanceof Error) return { isFlashNpub: false }
    return {
      isFlashNpub: true,
    }
  },
})

export default IsFlashNpubQuery
