import { GT } from "@graphql/index"
import { generateIdDocumentReadUrl } from "@services/storage"

import IError from "../../../shared/types/abstract/error"

const IdDocumentReadUrlPayload = GT.Object({
  name: "IdDocumentReadUrlPayload",
  fields: () => ({
    errors: {
      type: GT.NonNullList(IError),
    },
    readUrl: {
      type: GT.String,
      description: "Pre-signed URL for reading the ID document (valid for 1 hour)",
    },
  }),
})

const IdDocumentReadUrlQuery = GT.Field({
  type: GT.NonNull(IdDocumentReadUrlPayload),
  args: {
    fileKey: {
      type: GT.NonNull(GT.String),
      description: "Storage key of the ID document file",
    },
  },
  resolve: async (_, { fileKey }) => {
    const result = await generateIdDocumentReadUrl({ fileKey })

    if (result instanceof Error) {
      return { errors: [{ message: result.message }], readUrl: null }
    }

    return {
      errors: [],
      readUrl: result.readUrl,
    }
  },
})

export default IdDocumentReadUrlQuery
