import { GT } from "@graphql/index"

import IError from "../../../shared/types/abstract/error"

const FileUploadUrlPayload = GT.Object({
  name: "FileUploadUrlPayload",
  fields: () => ({
    errors: {
      type: GT.NonNullList(IError),
    },
    uploadUrl: {
      type: GT.String,
      description: "Pre-signed URL for uploading the file directly to storage",
    },
    fileUrl: {
      type: GT.String,
      description: "Public URL where the file will be accessible after upload",
    },
  }),
})

export default FileUploadUrlPayload
