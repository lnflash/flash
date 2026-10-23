import { createServer, request, Server } from "node:http"
import { AddressInfo } from "node:net"
import { crc32 } from "node:zlib"

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

let mockEndpoint: string

jest.mock("@config", () => ({
  get DO_SPACES_ENDPOINT() {
    return mockEndpoint
  },
  DO_SPACES_REGION: "us-east-1",
  DO_SPACES_BUCKET: "identity-offline-fixture",
  DO_SPACES_ACCESS_KEY: "OFFLINE_FIXTURE_ONLY",
  DO_SPACES_SECRET_KEY: "not-a-real-key",
}))
jest.mock("@services/tracing", () => ({
  asyncRunInSpan: (_name: string, _opts: unknown, fn: () => unknown) => fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))

import { generateIdDocumentUploadUrl } from "@services/storage"

// A real nonempty PNG, not an empty request standing in for a photo. Only a
// loopback HTTP fixture receives it; no storage account or real key is used.
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lmKsAAAAASUVORK5CYII=",
  "base64",
)
const observed: { body: Buffer; contentType?: string; query: URLSearchParams }[] = []
let server: Server

beforeAll(async () => {
  server = createServer((incoming, response) => {
    const chunks: Buffer[] = []
    incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    incoming.on("end", () => {
      const body = Buffer.concat(chunks)
      const query = new URL(incoming.url!, mockEndpoint).searchParams
      observed.push({ body, contentType: incoming.headers["content-type"], query })
      const checksum = Buffer.alloc(4)
      checksum.writeUInt32BE(crc32(body))
      // Emulate only S3's checksum/body acceptance, not its signature verifier.
      // The client uses the untouched real SDK URL, including its dummy SigV4.
      if (
        query.has("x-amz-checksum-crc32") &&
        query.get("x-amz-checksum-crc32") !== checksum.toString("base64")
      ) {
        response.writeHead(400).end("BadDigest")
      } else if (incoming.method !== "PUT" || !body.equals(image)) {
        response.writeHead(400).end("UnexpectedBody")
      } else {
        response.writeHead(200).end()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  mockEndpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
})

const put = (url: string) =>
  new Promise<number | undefined>((resolve, reject) => {
    const upload = request(
      url,
      { method: "PUT", headers: { "Content-Type": "image/png" } },
      (response) => {
        response.resume()
        response.on("end", () => resolve(response.statusCode))
      },
    )
    upload.on("error", reject)
    upload.end(image)
  })

it("reproduces the SDK default's invalid empty-body checksum for a later nonempty PUT", async () => {
  const client = new S3Client({
    endpoint: mockEndpoint,
    region: "us-east-1",
    // Explicit default makes this regression deterministic even if the test
    // shell has AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED.
    requestChecksumCalculation: "WHEN_SUPPORTED",
    credentials: {
      accessKeyId: "OFFLINE_FIXTURE_ONLY",
      secretAccessKey: "not-a-real-key",
    },
  })
  try {
    const url = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: "identity-offline-fixture",
        Key: "id_documents/alice/front.png",
        ContentType: "image/png",
        ACL: "private",
      }),
      { expiresIn: 900 },
    )
    expect(new URL(url).searchParams.get("x-amz-checksum-crc32")).toBe("AAAAAA==")
    expect(await put(url)).toBe(400)
  } finally {
    client.destroy()
  }
})

it("signs the actual storage service URL for a nonempty photo without an invented checksum", async () => {
  const generated = await generateIdDocumentUploadUrl({
    username: "alice",
    filename: "front.png",
    contentType: "image/png",
  })
  if (generated instanceof Error) throw generated
  const query = new URL(generated.uploadUrl).searchParams
  expect(query.has("x-amz-checksum-crc32")).toBe(false)
  expect(query.has("x-amz-sdk-checksum-algorithm")).toBe(false)
  expect(query.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256")
  expect(query.get("X-Amz-Expires")).toBe("900")
  expect(query.get("x-amz-acl")).toBe("private")
  expect(query.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/)
  expect(generated.fileKey).toBe("id_documents/alice/front.png")
  expect(await put(generated.uploadUrl)).toBe(200)
  expect(observed.at(-1)?.body).toEqual(image)
  expect(observed.at(-1)?.contentType).toBe("image/png")
})
