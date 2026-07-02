import { Accounts } from "@app"
import { RepositoryError } from "@domain/errors"
import { GT } from "@graphql/index"
import {
  IsFlashNpubInput,
  IsFlashNpubPayload,
} from "@graphql/public/types/object/is-flash-npub"

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
    if (output instanceof RepositoryError) return { isFlashNpub: false }
    else if (output instanceof Error) throw output
    return {
      isFlashNpub: true,
    }
  },
})

export default IsFlashNpubQuery
