const mockSend = jest.fn()
const mockDeleteObjectCommand = jest.fn()
const mockListObjectsV2Command = jest.fn()

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
  DeleteObjectCommand: jest
    .fn()
    .mockImplementation((input) => mockDeleteObjectCommand(input) ?? { input }),
  ListObjectsV2Command: jest
    .fn()
    .mockImplementation((input) => mockListObjectsV2Command(input) ?? { input }),
}))

jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn(),
}))

jest.mock("@config", () => ({
  DO_SPACES_ENDPOINT: "https://nyc3.digitaloceanspaces.com",
  DO_SPACES_REGION: "nyc3",
  DO_SPACES_BUCKET: "flash-test",
  DO_SPACES_ACCESS_KEY: "key",
  DO_SPACES_SECRET_KEY: "secret",
}))

jest.mock("@services/tracing", () => ({
  asyncRunInSpan: (_name: string, _opts: unknown, fn: () => unknown) => fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))

import { DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3"

import { deleteIdDocument, listIdDocuments } from "@services/storage"
import { StorageError } from "@services/storage/errors"

describe("deleteIdDocument", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("sends a DeleteObject for a key under id_documents/", async () => {
    mockSend.mockResolvedValue({})

    const result = await deleteIdDocument({ fileKey: "id_documents/alice_front.jpg" })

    expect(result).toEqual({ fileKey: "id_documents/alice_front.jpg" })
    expect(DeleteObjectCommand).toHaveBeenCalledWith({
      Bucket: "flash-test",
      Key: "id_documents/alice_front.jpg",
    })
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it("refuses keys outside id_documents/ without touching the client", async () => {
    const result = await deleteIdDocument({ fileKey: "backups/alice_front.jpg" })

    expect(result).toBeInstanceOf(StorageError)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it("wraps client failures in a StorageError", async () => {
    mockSend.mockRejectedValue(new Error("boom"))

    const result = await deleteIdDocument({ fileKey: "id_documents/alice_front.jpg" })

    expect(result).toBeInstanceOf(StorageError)
  })
})

describe("listIdDocuments", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("lists objects under the prefix and passes the continuation token through", async () => {
    mockSend.mockResolvedValue({
      Contents: [
        {
          Key: "id_documents/alice_front.jpg",
          Size: 10,
          LastModified: new Date("2026-01-01"),
        },
        { Key: "id_documents/bob_front.jpg", Size: 20 },
        { Size: 5 },
      ],
      IsTruncated: true,
      NextContinuationToken: "next-1",
    })

    const result = await listIdDocuments({ continuationToken: "prev" })

    expect(ListObjectsV2Command).toHaveBeenCalledWith({
      Bucket: "flash-test",
      Prefix: "id_documents/",
      ContinuationToken: "prev",
      MaxKeys: 1000,
    })
    expect(result).toEqual({
      objects: [
        {
          fileKey: "id_documents/alice_front.jpg",
          size: 10,
          lastModified: new Date("2026-01-01"),
        },
        { fileKey: "id_documents/bob_front.jpg", size: 20, lastModified: undefined },
      ],
      continuationToken: "next-1",
    })
  })

  it("returns no continuation token on the last page", async () => {
    mockSend.mockResolvedValue({ Contents: [], IsTruncated: false })

    const result = await listIdDocuments({ prefix: "id_documents/alice_" })

    expect(result).toEqual({ objects: [], continuationToken: undefined })
  })

  it("refuses a prefix outside id_documents/", async () => {
    const result = await listIdDocuments({ prefix: "backups/" })

    expect(result).toBeInstanceOf(StorageError)
    expect(mockSend).not.toHaveBeenCalled()
  })
})
