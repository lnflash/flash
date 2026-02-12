import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

import {
  DO_SPACES_ACCESS_KEY,
  DO_SPACES_BUCKET,
  DO_SPACES_ENDPOINT,
  DO_SPACES_REGION,
  DO_SPACES_SECRET_KEY,
} from "@config"
import { asyncRunInSpan, recordExceptionInCurrentSpan } from "@services/tracing"
import { ErrorLevel } from "@domain/shared"

import { InvalidFileTypeError, StorageError } from "./errors"

const ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const
const UPLOAD_URL_EXPIRY_SECONDS = 15 * 60 // 15 minutes
const READ_URL_EXPIRY_SECONDS = 60 * 60 // 1 hour

const isValidContentType = (contentType: string) =>
  ALLOWED_CONTENT_TYPES.includes(contentType as (typeof ALLOWED_CONTENT_TYPES)[number])

let s3Client: S3Client | null = null

const getS3Client = (): S3Client | StorageError => {
  if (s3Client) return s3Client

  if (
    !DO_SPACES_ENDPOINT ||
    !DO_SPACES_REGION ||
    !DO_SPACES_ACCESS_KEY ||
    !DO_SPACES_SECRET_KEY
  ) {
    return new StorageError("DigitalOcean Spaces configuration is incomplete")
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

type GenerateIdDocumentUploadUrlArgs = {
  username: string
  filename: string
  contentType: string
}

type PresignedUploadUrlResult = {
  uploadUrl: string
  fileKey: string
}

export const generateIdDocumentUploadUrl = async ({
  username,
  filename,
  contentType,
}: GenerateIdDocumentUploadUrlArgs): Promise<PresignedUploadUrlResult | StorageError> => {
  return asyncRunInSpan(
    "services.storage.generateIdDocumentUploadUrl",
    {
      attributes: {
        "storage.username": username,
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
        return new StorageError("DO_SPACES_BUCKET is not configured")
      }

      const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, "_")
      const objectKey = `id_documents/${username}_${sanitizedFilename}`

      try {
        const command = new PutObjectCommand({
          Bucket: DO_SPACES_BUCKET,
          Key: objectKey,
          ContentType: contentType,
          ACL: "private", // Private - requires signed URL to read
        })

        const uploadUrl = await getSignedUrl(client, command, {
          expiresIn: UPLOAD_URL_EXPIRY_SECONDS,
        })

        // Return the file key instead of public URL (since file is private)
        return { uploadUrl, fileKey: objectKey }
      } catch (error) {
        recordExceptionInCurrentSpan({
          error,
          level: ErrorLevel.Critical,
          fallbackMsg: "Failed to generate pre-signed URL for ID document upload",
        })
        return new StorageError("Failed to generate pre-signed URL")
      }
    },
  )
}

export const generateIdDocumentReadUrl = async ({
  fileKey,
}: {
  fileKey: string
}): Promise<{ readUrl: string } | StorageError> => {
  return asyncRunInSpan(
    "services.storage.generateIdDocumentReadUrl",
    {
      attributes: {
        "storage.fileKey": fileKey,
      },
    },
    async () => {
      const client = getS3Client()
      if (client instanceof Error) {
        return client
      }

      if (!DO_SPACES_BUCKET) {
        return new StorageError("DO_SPACES_BUCKET is not configured")
      }

      try {
        const command = new GetObjectCommand({
          Bucket: DO_SPACES_BUCKET,
          Key: fileKey,
        })

        const readUrl = await getSignedUrl(client, command, {
          expiresIn: READ_URL_EXPIRY_SECONDS,
        })

        return { readUrl }
      } catch (error) {
        recordExceptionInCurrentSpan({
          error,
          level: ErrorLevel.Critical,
          fallbackMsg: "Failed to generate pre-signed read URL for ID document",
        })
        return new StorageError("Failed to generate pre-signed read URL")
      }
    },
  )
}
