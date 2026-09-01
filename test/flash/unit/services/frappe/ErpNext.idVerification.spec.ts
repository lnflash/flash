jest.mock("axios", () => ({
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  isAxiosError: jest.fn((err) => Boolean(err?.isAxiosError)),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/tracing", () => ({
  recordExceptionInCurrentSpan: jest.fn(),
}))

jest.mock("@config", () => ({
  FrappeConfig: undefined,
}))

import axios from "axios"

import { IdentitySource, UpgradeEvidenceType } from "@domain/accounts"
import { ErpNext } from "@services/frappe/ErpNext"
import {
  IdVerificationCreateError,
  IdVerificationQueryError,
  IdVerificationUpdateError,
  UpgradeRequestQueryError,
} from "@services/frappe/errors"
import { IdVerification } from "@services/frappe/models/IdVerification"
import { baseLogger } from "@services/logger"

const mockedAxios = axios as unknown as {
  get: jest.Mock
  post: jest.Mock
  put: jest.Mock
}

const client = new ErpNext("https://erp.example", "erp.example", {
  apiKey: "key",
  apiSecret: "secret",
})

const expectedHeaders = {
  "Content-Type": "application/json",
  "Authorization": "token key:secret",
  "Host": "erp.example",
  "Expect": "",
}

const doc = IdVerification.fromEvidence({
  upgradeRequest: "AUR-0001",
  identitySource: IdentitySource.Capture,
  capturedAt: new Date("2026-09-01T12:00:00Z"),
  evidence: [
    { type: UpgradeEvidenceType.IdFront, fileKey: "id_documents/alice_front.jpg" },
  ],
})

describe("ErpNext.postIdVerification", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("POSTs the document with token auth + Host header", async () => {
    mockedAxios.post.mockResolvedValue({ data: { data: { name: "IDV-0001" } } })

    const result = await client.postIdVerification(doc)

    expect(result).toEqual({ name: "IDV-0001" })
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://erp.example/api/resource/ID Verification",
      expect.objectContaining({
        doctype: "ID Verification",
        upgrade_request: "AUR-0001",
        status: "Checks pending",
        identity_source: "capture",
        evidence: [expect.objectContaining({ evidence_type: "id_front" })],
      }),
      { headers: expectedHeaders },
    )
  })

  it("returns IdVerificationCreateError and logs at warn when the doctype is missing", async () => {
    mockedAxios.post.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 404,
        data: { exception: "DoesNotExistError: DocType ID Verification" },
      },
    })

    const result = await client.postIdVerification(doc)

    expect(result).toBeInstanceOf(IdVerificationCreateError)
    expect(baseLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 404, upgradeRequest: "AUR-0001" }),
      "Error creating ID Verification in ERPNext",
    )
    expect(baseLogger.error).not.toHaveBeenCalled()
  })

  it("treats a response without a name as a failure", async () => {
    mockedAxios.post.mockResolvedValue({ data: { data: {} } })

    expect(await client.postIdVerification(doc)).toBeInstanceOf(IdVerificationCreateError)
  })
})

describe("ErpNext ID Verification reads", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("lists names with pagination params", async () => {
    mockedAxios.get.mockResolvedValue({
      data: { data: [{ name: "IDV-1" }, { name: "IDV-2" }] },
    })

    const result = await client.getIdVerificationList({ limitStart: 100, pageLength: 50 })

    expect(result).toEqual(["IDV-1", "IDV-2"])
    expect(mockedAxios.get).toHaveBeenCalledWith(
      "https://erp.example/api/resource/ID Verification",
      {
        params: {
          fields: JSON.stringify(["name"]),
          order_by: "creation asc",
          limit_start: 100,
          limit_page_length: 50,
        },
        headers: expectedHeaders,
      },
    )
  })

  it("wraps list failures", async () => {
    mockedAxios.get.mockRejectedValue(new Error("down"))
    expect(await client.getIdVerificationList()).toBeInstanceOf(IdVerificationQueryError)
  })

  it("hydrates one document by id", async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: {
          name: "IDV-1",
          upgrade_request: "AUR-0001",
          status: "Checks pending",
          identity_source: "capture",
          evidence: [
            { name: "row-1", evidence_type: "selfie", file_key: "id_documents/a_s.jpg" },
          ],
        },
      },
    })

    const result = await client.getIdVerificationById("IDV-1")

    expect(result).toBeInstanceOf(IdVerification)
    expect((result as IdVerification).evidence[0]).toEqual(
      expect.objectContaining({ rowName: "row-1", type: "selfie" }),
    )
    expect(mockedAxios.get).toHaveBeenCalledWith(
      "https://erp.example/api/resource/ID Verification/IDV-1",
      { headers: expectedHeaders },
    )
  })

  it("returns a query error when the detail response is empty", async () => {
    mockedAxios.get.mockResolvedValue({ data: {} })
    expect(await client.getIdVerificationById("IDV-1")).toBeInstanceOf(
      IdVerificationQueryError,
    )
  })
})

describe("ErpNext.updateIdVerificationEvidence", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("PUTs the full evidence table on the parent", async () => {
    mockedAxios.put.mockResolvedValue({ data: { data: { name: "IDV-1" } } })
    const rows = [
      {
        name: "row-1",
        evidence_type: "id_front",
        file_key: "k",
        deleted_at: "2033-01-01 00:00:00",
      },
    ]

    const result = await client.updateIdVerificationEvidence("IDV-1", rows)

    expect(result).toBeUndefined()
    expect(mockedAxios.put).toHaveBeenCalledWith(
      "https://erp.example/api/resource/ID Verification/IDV-1",
      { evidence: rows },
      { headers: expectedHeaders },
    )
  })

  it("wraps update failures", async () => {
    mockedAxios.put.mockRejectedValue(new Error("down"))
    expect(await client.updateIdVerificationEvidence("IDV-1", [])).toBeInstanceOf(
      IdVerificationUpdateError,
    )
  })
})

describe("ErpNext.getUpgradeRequestDecision", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("prefers reviewed_at and falls back to modified", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        data: {
          name: "AUR-1",
          username: "alice",
          status: "Rejected",
          modified: "2026-02-02 02:02:02.000000",
          reviewed_at: "2026-01-01 01:01:01",
        },
      },
    })
    expect(await client.getUpgradeRequestDecision("AUR-1")).toEqual({
      name: "AUR-1",
      username: "alice",
      status: "Rejected",
      decidedAt: new Date("2026-01-01T01:01:01.000Z"),
    })

    mockedAxios.get.mockResolvedValueOnce({
      data: {
        data: {
          name: "AUR-2",
          username: "bob",
          status: "Approved",
          modified: "2026-02-02 02:02:02",
        },
      },
    })
    expect(await client.getUpgradeRequestDecision("AUR-2")).toEqual(
      expect.objectContaining({ decidedAt: new Date("2026-02-02T02:02:02.000Z") }),
    )
  })

  it("wraps failures", async () => {
    mockedAxios.get.mockRejectedValue(new Error("down"))
    expect(await client.getUpgradeRequestDecision("AUR-1")).toBeInstanceOf(
      UpgradeRequestQueryError,
    )
  })
})

describe("ErpNext.postUpgradeRequest error log", () => {
  it("does not log the applicant's PII", async () => {
    jest.clearAllMocks()
    mockedAxios.post.mockRejectedValue(new Error("down"))
    const req = {
      username: "alice",
      requestedLevel: 2,
      toErpnext: () => ({
        full_name: "Alice Applicant",
        phone_number: "+18765550100",
        email: "alice@example.com",
        address_line1: "1 Main St",
      }),
    }

    await client.postUpgradeRequest(req as never)

    const [payload] = (baseLogger.error as jest.Mock).mock.calls[0]
    const serialized = JSON.stringify(payload)
    expect(payload).toEqual(
      expect.objectContaining({ username: "alice", requestedLevel: 2 }),
    )
    for (const pii of [
      "Alice Applicant",
      "+18765550100",
      "alice@example.com",
      "1 Main St",
    ]) {
      expect(serialized).not.toContain(pii)
    }
  })
})
