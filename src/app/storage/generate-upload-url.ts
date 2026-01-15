import { generatePresignedUploadUrl as generatePresignedUploadUrlService } from "@services/storage"

type GenerateUploadUrlArgs = {
  accountId: AccountId
  username?: string
  filename: string
  contentType: string
}

export const generateUploadUrl = async ({
  accountId,
  username,
  filename,
  contentType,
}: GenerateUploadUrlArgs) => {
  return generatePresignedUploadUrlService({
    accountId,
    username,
    filename,
    contentType,
  })
}
