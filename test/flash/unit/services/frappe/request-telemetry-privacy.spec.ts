jest.mock("axios", () => ({
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  isAxiosError: jest.fn((err) => Boolean(err?.isAxiosError)),
}))
jest.mock("@services/logger", () => ({
  baseLogger: { error: jest.fn(), warn: jest.fn() },
}))
jest.mock("@services/tracing", () => ({ recordExceptionInCurrentSpan: jest.fn() }))
jest.mock("@config", () => ({ FrappeConfig: undefined }))

import axios from "axios"
import { IdentitySource, UpgradeEvidenceType } from "@domain/accounts"
import { Validated } from "@domain/shared"
import { ErpNext } from "@services/frappe/ErpNext"
import { recordErpRequestFailure } from "@services/frappe/telemetry"
import {
  AccountUpgradeRequest,
  RequestStatus,
} from "@services/frappe/models/AccountUpgradeRequest"
import { BankAccountUpdateRequest } from "@services/frappe/models/BankAccountUpdateRequest"
import { IdVerification } from "@services/frappe/models/IdVerification"
import { baseLogger } from "@services/logger"
import { recordExceptionInCurrentSpan } from "@services/tracing"

const http = jest.mocked(axios)
const client = new ErpNext("https://erp.invalid", "erp.invalid", {
  apiKey: "PRIVATE_API_KEY",
  apiSecret: "PRIVATE_API_SECRET",
})
const privateBody = {
  full_name: "PRIVATE_NAME",
  phone: "PRIVATE_PHONE",
  email: "PRIVATE_EMAIL",
  account_number: "PRIVATE_BANK_NUMBER",
  address: "PRIVATE_POSTAL_ADDRESS",
  file_key: "PRIVATE_ID_EVIDENCE",
}
const upgrade = {
  username: "PRIVATE_USERNAME",
  requestedLevel: 2,
  toErpnext: () => ({ ...privateBody }),
} as unknown as Validated<AccountUpgradeRequest>
const doc = IdVerification.fromEvidence({
  upgradeRequest: "PRIVATE_UPGRADE_ID",
  identitySource: IdentitySource.Capture,
  capturedAt: new Date("2026-10-22T00:00:00Z"),
  evidence: [
    {
      type: UpgradeEvidenceType.IdFront,
      fileKey: "id_documents/PRIVATE_USERNAME/PRIVATE_ID_EVIDENCE.jpg",
    },
  ],
})
const bank = {
  erpParty: "PRIVATE_ERP_PARTY",
  bankName: "PRIVATE_BANK",
  accountNumber: "PRIVATE_BANK_NUMBER",
  accountType: "Savings",
  currency: "USD",
  bankBranch: "PRIVATE_BRANCH",
  accountName: "PRIVATE_NAME",
}
const bankRequest = new BankAccountUpdateRequest(
  "PRIVATE_REQUEST_ID",
  bank.erpParty,
  "PRIVATE_BANK_ID",
  RequestStatus.Pending,
  {
    bank: bank.bankName,
    bank_account_no: bank.accountNumber,
    branch_code: bank.bankBranch,
    account_type: bank.accountType,
    currency: bank.currency,
  },
  "PRIVATE_SUPPORT_NOTE",
)

function privateError() {
  return Object.assign(new Error("PRIVATE_ERROR_MESSAGE"), {
    stack: "PRIVATE_ERROR_STACK",
    isAxiosError: true,
    code: "ERR_BAD_RESPONSE",
    config: {
      headers: { Authorization: "token PRIVATE_API_KEY:PRIVATE_API_SECRET" },
      data: JSON.stringify(privateBody),
      url: "https://erp.invalid/PRIVATE_SIGNED_URL",
    },
    response: {
      status: 500,
      data: {
        exception: "PRIVATE_PROVIDER_EXCEPTION",
        _server_messages: "PRIVATE_PROVIDER_BODY",
        ...privateBody,
      },
    },
  })
}
function serialize(value: unknown) {
  return JSON.stringify(value, (_key, entry) =>
    entry instanceof Error
      ? { ...entry, message: entry.message, stack: entry.stack }
      : entry,
  )
}
function expectPrivateDataAbsent(result?: unknown) {
  const captured = serialize({
    logs: [
      jest.mocked(baseLogger.error).mock.calls,
      jest.mocked(baseLogger.warn).mock.calls,
    ],
    spans: jest.mocked(recordExceptionInCurrentSpan).mock.calls,
    result,
  })
  expect(captured).not.toContain("PRIVATE_")
  expect(captured).not.toContain("erpnext.exception")
}
beforeEach(() => {
  jest.clearAllMocks()
  for (const method of [http.get, http.post, http.put])
    method.mockRejectedValue(privateError())
})

const requests: [string, () => Promise<unknown>][] = [
  ["postUpgradeRequest", () => client.postUpgradeRequest(upgrade)],
  ["getAccountUpgradeRequestList", () => client.getAccountUpgradeRequestList({})],
  [
    "getAccountUpgradeRequestById",
    () => client.getAccountUpgradeRequestById("PRIVATE_UPGRADE_ID"),
  ],
  [
    "getUpgradeRequestDecision",
    () => client.getUpgradeRequestDecision("PRIVATE_UPGRADE_ID"),
  ],
  ["postIdVerification", () => client.postIdVerification(doc)],
  ["getIdVerificationList", () => client.getIdVerificationList()],
  ["getIdVerificationById", () => client.getIdVerificationById("PRIVATE_EVIDENCE_ID")],
  [
    "updateIdVerificationEvidence",
    () =>
      client.updateIdVerificationEvidence(
        "PRIVATE_EVIDENCE_ID",
        doc.toErpnext().evidence ?? [],
      ),
  ],
  [
    "getIdVerificationByUpgradeRequest",
    () => client.getIdVerificationByUpgradeRequest("PRIVATE_UPGRADE_ID"),
  ],
  ["getDecisionReason", () => client.getDecisionReason("PRIVATE_DECISION_REASON")],
  [
    "closeAccountUpgradeRequests",
    () => client.closeAccountUpgradeRequests(["PRIVATE_UPGRADE_ID"]),
  ],
  [
    "closeBankAccountUpdateRequests",
    () => client.closeBankAccountUpdateRequests(["PRIVATE_BANK_REQUEST_ID"]),
  ],
  [
    "getBankAccountsByCustomer",
    () => client.getBankAccountsByCustomer("PRIVATE_CUSTOMER"),
  ],
  ["createBankAccount", () => client.createBankAccount(bank)],
  [
    "updateBankAccount",
    () => client.updateBankAccount({ ...bank, bankAccountId: "PRIVATE_BANK_ID" }),
  ],
  [
    "deleteBankAccount",
    () =>
      client.deleteBankAccount({
        erpParty: bank.erpParty,
        bankAccountId: "PRIVATE_BANK_ID",
      }),
  ],
  [
    "setDefaultBankAccount",
    () =>
      client.setDefaultBankAccount({
        erpParty: bank.erpParty,
        bankAccountId: "PRIVATE_BANK_ID",
      }),
  ],
  ["listBanks", () => client.listBanks()],
  [
    "postBankAccountUpdateRequest",
    () => client.postBankAccountUpdateRequest(bankRequest),
  ],
  [
    "getOpenBankAccountUpdateRequestsForAccount",
    () => client.getOpenBankAccountUpdateRequestsForAccount("PRIVATE_BANK_ID"),
  ],
  [
    "getLatestBankAccountUpdateRequestForAccount",
    () => client.getLatestBankAccountUpdateRequestForAccount("PRIVATE_BANK_ID"),
  ],
]
it.each(requests)(
  "keeps %s failure credentials/body/provider text out of logs, spans and returned errors",
  async (_name, run) => {
    const result = await run()
    expect(result).toBeInstanceOf(Error)
    expect(recordExceptionInCurrentSpan).toHaveBeenCalledTimes(1)
    expectPrivateDataAbsent(result)
  },
)

it("preserves authenticated identity and bank request bodies despite sanitized failure recording", async () => {
  await client.postUpgradeRequest(upgrade)
  expect(http.post).toHaveBeenLastCalledWith(expect.any(String), upgrade.toErpnext(), {
    headers: expect.objectContaining({
      Authorization: "token PRIVATE_API_KEY:PRIVATE_API_SECRET",
    }),
  })
  await client.postBankAccountUpdateRequest(bankRequest)
  expect(http.post).toHaveBeenLastCalledWith(
    expect.any(String),
    bankRequest.toErpnext(),
    {
      headers: expect.objectContaining({
        Authorization: "token PRIVATE_API_KEY:PRIVATE_API_SECRET",
      }),
    },
  )
  await client.postIdVerification(doc)
  expect(http.post).toHaveBeenLastCalledWith(expect.any(String), doc.toErpnext(), {
    headers: expect.objectContaining({
      Authorization: "token PRIVATE_API_KEY:PRIVATE_API_SECRET",
    }),
  })
  expectPrivateDataAbsent()
})

it("does not retain provider text from unsuccessful 2xx bank responses or bulk failed-doc payloads", async () => {
  http.post.mockResolvedValue({
    data: {
      message: {
        success: false,
        error: "PRIVATE_BANK_NUMBER",
        failed_docs: [{ docname: "PRIVATE_NAME", reason: "PRIVATE_BANK_NUMBER" }],
      },
    },
  })
  for (const run of [
    () => client.createBankAccount(bank),
    () => client.updateBankAccount({ ...bank, bankAccountId: "PRIVATE_BANK_ID" }),
    () =>
      client.deleteBankAccount({
        erpParty: bank.erpParty,
        bankAccountId: "PRIVATE_BANK_ID",
      }),
    () =>
      client.setDefaultBankAccount({
        erpParty: bank.erpParty,
        bankAccountId: "PRIVATE_BANK_ID",
      }),
    () => client.closeBankAccountUpdateRequests(["PRIVATE_NAME"]),
  ]) {
    const result = await run()
    expect(result).toBeInstanceOf(Error)
    expectPrivateDataAbsent(result)
  }
})

it("retains only allowlisted transport codes and integer HTTP status, not arbitrary error strings", () => {
  const error = privateError()
  recordErpRequestFailure(error, "createBankAccount")
  expect(baseLogger.error).toHaveBeenLastCalledWith(
    { operation: "createBankAccount", code: "ERR_BAD_RESPONSE", status: 500 },
    "ERPNext request failed",
  )
  error.code = "PRIVATE_TRANSPORT_CODE"
  error.response.status = Number.NaN
  recordErpRequestFailure(error, "createBankAccount")
  expect(baseLogger.error).toHaveBeenLastCalledWith(
    { operation: "createBankAccount", code: "UNKNOWN" },
    "ERPNext request failed",
  )
  expectPrivateDataAbsent()
})
