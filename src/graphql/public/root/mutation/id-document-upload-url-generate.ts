import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { generateIdDocumentUploadUrl } from "@services/storage"

import IError from "../../../shared/types/abstract/error"

const IdDocumentUploadUrlPayload = GT.Object({
  name: "IdDocumentUploadUrlPayload",
  fields: () => ({
    errors: {
      type: GT.NonNullList(IError),
    },
    uploadUrl: {
      type: GT.String,
      description: "Pre-signed URL for uploading the ID document directly to storage",
    },
    fileKey: {
      type: GT.String,
      description: "Storage key for the uploaded file (use to generate read URLs)",
    },
  }),
})

const IdDocumentUploadUrlGenerateInput = GT.Input({
  name: "IdDocumentUploadUrlGenerateInput",
  fields: () => ({
    filename: {
      type: GT.NonNull(GT.String),
      description: "Original filename",
    },
    contentType: {
      type: GT.NonNull(GT.String),
      description: "MIME type (image/jpeg, image/png, image/webp)",
    },
  }),
})

const IdDocumentUploadUrlGenerateMutation = GT.Field<
  null,
  GraphQLPublicContextAuth,
  {
    input: {
      filename: string
      contentType: string
    }
  }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(IdDocumentUploadUrlPayload),
  args: {
    input: { type: GT.NonNull(IdDocumentUploadUrlGenerateInput) },
  },
  resolve: async (_, args, { domainAccount }) => {
    const { filename, contentType } = args.input

    if (!domainAccount.username) {
      return { errors: [{ message: "Username is required for ID document upload" }] }
    }

    const result = await generateIdDocumentUploadUrl({
      username: domainAccount.username,
      filename,
      contentType,
    })

    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }

    return {
      errors: [],
      uploadUrl: result.uploadUrl,
      fileKey: result.fileKey,
    }
  },
})

export default IdDocumentUploadUrlGenerateMutation
