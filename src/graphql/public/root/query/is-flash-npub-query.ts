import { GT } from "@graphql/index"

import { mapError } from "@graphql/error-map"

import { Accounts } from "@app"

const IsFlashNpubQuery = GT.Field({
  type: GT.Boolean,
  args: {
    npub: {
      type: GT.String,
    },
  },
  resolve: async (_, args) => {
    const { npub } = args

    if (npub instanceof Error) {
      throw npub
    }
    console.log("Inside ISFLashNpubQuery", npub)
    const isFlashNpub = await Accounts.npubPresent(npub)
    console.log("Got Result", isFlashNpub)
    return isFlashNpub
  },
})

export default IsFlashNpubQuery
