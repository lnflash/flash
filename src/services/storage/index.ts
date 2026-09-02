import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3"
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
export const ID_DOCUMENTS_PREFIX = "id_documents/"
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
      // `/` (not `_`) separates the username from the filename: usernames may
      // contain underscores, so `_` would make the ownership prefix check in
      // domain/accounts/upgrade-evidence.ts ambiguous between accounts whose
      // usernames overlap that way. See idDocumentKeyPrefixForUsername.
      const objectKey = `id_documents/${username}/${sanitizedFilename}`

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

// Permanently remove one ID document. Only keys under the id_documents/
// prefix are deletable through this service — it is the retention job's
// tool, not a general-purpose delete.
export const deleteIdDocument = async ({
  fileKey,
}: {
  fileKey: string
}): Promise<{ fileKey: string } | StorageError> => {
  return asyncRunInSpan(
    "services.storage.deleteIdDocument",
    {
      attributes: {
        "storage.fileKey": fileKey,
      },
    },
    async () => {
      if (!fileKey.startsWith(ID_DOCUMENTS_PREFIX)) {
        return new StorageError(
          `Refusing to delete a key outside ${ID_DOCUMENTS_PREFIX}: ${fileKey}`,
        )
      }

      const client = getS3Client()
      if (client instanceof Error) {
        return client
      }

      if (!DO_SPACES_BUCKET) {
        return new StorageError("DO_SPACES_BUCKET is not configured")
      }

      try {
        await client.send(
          new DeleteObjectCommand({
            Bucket: DO_SPACES_BUCKET,
            Key: fileKey,
          }),
        )
        return { fileKey }
      } catch (error) {
        recordExceptionInCurrentSpan({
          error,
          level: ErrorLevel.Critical,
          fallbackMsg: "Failed to delete ID document",
        })
        return new StorageError("Failed to delete ID document")
      }
    },
  )
}

export type IdDocumentObject = {
  fileKey: string
  size?: number
  lastModified?: Date
}

export type ListIdDocumentsResult = {
  objects: IdDocumentObject[]
  continuationToken?: string
}

// Page through the ID documents in the bucket. `prefix` is always kept under
// id_documents/.
export const listIdDocuments = async ({
  prefix = ID_DOCUMENTS_PREFIX,
  continuationToken,
  maxKeys = 1000,
}: {
  prefix?: string
  continuationToken?: string
  maxKeys?: number
} = {}): Promise<ListIdDocumentsResult | StorageError> => {
  return asyncRunInSpan(
    "services.storage.listIdDocuments",
    {
      attributes: {
        "storage.prefix": prefix,
      },
    },
    async () => {
      if (!prefix.startsWith(ID_DOCUMENTS_PREFIX)) {
        return new StorageError(
          `Prefix must start with ${ID_DOCUMENTS_PREFIX}: ${prefix}`,
        )
      }

      const client = getS3Client()
      if (client instanceof Error) {
        return client
      }

      if (!DO_SPACES_BUCKET) {
        return new StorageError("DO_SPACES_BUCKET is not configured")
      }

      try {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: DO_SPACES_BUCKET,
            Prefix: prefix,
            ContinuationToken: continuationToken,
            MaxKeys: maxKeys,
          }),
        )

        const objects: IdDocumentObject[] = (response.Contents ?? [])
          .filter((object) => typeof object.Key === "string")
          .map((object) => ({
            fileKey: object.Key as string,
            size: object.Size,
            lastModified: object.LastModified,
          }))

        return {
          objects,
          continuationToken: response.IsTruncated
            ? response.NextContinuationToken
            : undefined,
        }
      } catch (error) {
        recordExceptionInCurrentSpan({
          error,
          level: ErrorLevel.Critical,
          fallbackMsg: "Failed to list ID documents",
        })
        return new StorageError("Failed to list ID documents")
      }
    },
  )
}
