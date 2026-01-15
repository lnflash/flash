import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

import {
  DO_SPACES_ACCESS_KEY,
  DO_SPACES_BUCKET,
  DO_SPACES_ENDPOINT,
  DO_SPACES_REGION,
  DO_SPACES_SECRET_KEY,
} from "@config"
import {
  SemanticAttributes,
  asyncRunInSpan,
  recordExceptionInCurrentSpan,
} from "@services/tracing"
import { ErrorLevel } from "@domain/shared"

import { InvalidFileTypeError, StorageConfigError, StorageUploadError } from "./errors"

const ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const

const PRESIGNED_URL_EXPIRY_SECONDS = 15 * 60 // 15 minutes

type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number]

const isValidContentType = (contentType: string): contentType is AllowedContentType =>
  ALLOWED_CONTENT_TYPES.includes(contentType as AllowedContentType)

let s3Client: S3Client | null = null

const getS3Client = (): S3Client | StorageConfigError => {
  if (s3Client) return s3Client

  if (
    !DO_SPACES_ENDPOINT ||
    !DO_SPACES_REGION ||
    !DO_SPACES_ACCESS_KEY ||
    !DO_SPACES_SECRET_KEY
  ) {
    return new StorageConfigError("DigitalOcean Spaces configuration is incomplete")
  }

  s3Client = new S3Client({
    endpoint: DO_SPACES_ENDPOINT,
    region: DO_SPACES_REGION,
    credentials: {
      accessKeyId: DO_SPACES_ACCESS_KEY,
      secretAccessKey: DO_SPACES_SECRET_KEY,
    },
  })

  return s3Client
}

type GeneratePresignedUploadUrlArgs = {
  accountId: AccountId
  username?: string
  filename: string
  contentType: string
}

type PresignedUrlResult = {
  uploadUrl: string
  fileUrl: string
}

export const generatePresignedUploadUrl = async ({
  accountId,
  username,
  filename,
  contentType,
}: GeneratePresignedUploadUrlArgs): Promise<
  PresignedUrlResult | InvalidFileTypeError | StorageConfigError | StorageUploadError
> => {
  return asyncRunInSpan(
    "services.storage.generatePresignedUploadUrl",
    {
      attributes: {
        [SemanticAttributes.CODE_FUNCTION]: "generatePresignedUploadUrl",
        [SemanticAttributes.CODE_NAMESPACE]: "services.storage",
        "storage.accountId": accountId,
        "storage.filename": filename,
        "storage.contentType": contentType,
      },
    },
    async () => {
      if (!isValidContentType(contentType)) {
        return new InvalidFileTypeError(contentType)
      }

      const client = getS3Client()
      if (client instanceof Error) {
        return client
      }

      if (!DO_SPACES_BUCKET) {
        return new StorageConfigError("DO_SPACES_BUCKET is not configured")
      }

      const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, "_")
      const objectKey = `id_documents/${username}_${sanitizedFilename}`

      try {
        const command = new PutObjectCommand({
          Bucket: DO_SPACES_BUCKET,
          Key: objectKey,
          ContentType: contentType,
          ACL: "public-read",
        })

        const uploadUrl = await getSignedUrl(client, command, {
          expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
        })

        // Construct the public file URL
        // DO Spaces URLs follow: https://{bucket}.{region}.digitaloceanspaces.com/{key}
        // or via CDN: https://{bucket}.{region}.cdn.digitaloceanspaces.com/{key}
        const endpointUrl = new URL(DO_SPACES_ENDPOINT!)
        const fileUrl = `https://${DO_SPACES_BUCKET}.${DO_SPACES_REGION}.digitaloceanspaces.com/${objectKey}`

        return { uploadUrl, fileUrl }
      } catch (error) {
        recordExceptionInCurrentSpan({
          error,
          level: ErrorLevel.Critical,
          fallbackMsg: "Failed to generate pre-signed URL",
        })
        return new StorageUploadError("Failed to generate pre-signed URL")
      }
    },
  )
}

export { InvalidFileTypeError, StorageConfigError, StorageUploadError } from "./errors"
