import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import FileUploadUrlPayload from "@graphql/public/types/payload/file-upload-url"
import { Storage } from "@app"

const FileUploadUrlGenerateInput = GT.Input({
  name: "FileUploadUrlGenerateInput",
  fields: () => ({
    filename: {
      type: GT.NonNull(GT.String),
      description: "Original filename (used for extension/key)",
    },
    contentType: {
      type: GT.NonNull(GT.String),
      description: "MIME type (image/jpeg, image/png, image/webp, image/gif)",
    },
  }),
})

const FileUploadUrlGenerateMutation = GT.Field<
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
  type: GT.NonNull(FileUploadUrlPayload),
  args: {
    input: { type: GT.NonNull(FileUploadUrlGenerateInput) },
  },
  resolve: async (_, args, { domainAccount }) => {
    const { filename, contentType } = args.input

    const result = await Storage.generateUploadUrl({
      accountId: domainAccount.id,
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
      fileUrl: result.fileUrl,
    }
  },
})

export default FileUploadUrlGenerateMutation
