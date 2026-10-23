import { isAxiosError } from "axios"

import { baseLogger } from "@services/logger"
import { recordExceptionInCurrentSpan } from "@services/tracing"

const transportCodes = new Set([
  "ERR_BAD_REQUEST",
  "ERR_BAD_RESPONSE",
  "ERR_NETWORK",
  "ERR_CANCELED",
  "ECONNABORTED",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
])

type ErpTelemetryOperation =
  | "draftCashout"
  | "submitCashout"
  | "delete"
  | "getCashoutExchangeRate"
  | "getFygaroSettings"
  | "getFeeDiscounts"
  | "getReferralSettings"
  | "getReferralPayoutAllowlist"
  | "getAllowedCountries"
  | "sumFygaroTopupGrossCentsSince"
  | "upsertBridgeTransferRequest"
  | "completeBridgeTopupByTxHash"
  | "sumFygaroCompletedNetCentsSince"
  | "queryUncreditedFygaroTopups"
  | "findBridgeTransferRequest"
  | "postUpgradeRequest"
  | "getAccountUpgradeRequestList"
  | "getAccountUpgradeRequestById"
  | "getUpgradeRequestDecision"
  | "postIdVerification"
  | "getIdVerificationList"
  | "getIdVerificationById"
  | "updateIdVerificationEvidence"
  | "getIdVerificationByUpgradeRequest"
  | "getDecisionReason"
  | "setStatusForRequests"
  | "getBankAccountsByCustomer"
  | "listBanks"
  | "postBankAccountUpdateRequest"
  | "getOpenBankAccountUpdateRequestsForAccount"
  | "getLatestBankAccountUpdateRequestForAccount"
  | "createBankAccount"
  | "updateBankAccount"
  | "deleteBankAccount"
  | "setDefaultBankAccount"

/** Never serialize an AxiosError: its config retains API credentials and body. */
export const recordErpRequestFailure = (
  error: unknown,
  operation: ErpTelemetryOperation,
  level: "error" | "warn" = "error",
): void => {
  const status = isAxiosError(error) ? error.response?.status : undefined
  const httpStatus =
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
      ? status
      : undefined
  const code =
    isAxiosError(error) &&
    typeof error.code === "string" &&
    transportCodes.has(error.code)
      ? error.code
      : "UNKNOWN"
  baseLogger[level](
    { operation, code, ...(httpStatus === undefined ? {} : { status: httpStatus }) },
    "ERPNext request failed",
  )
  recordExceptionInCurrentSpan({
    error: new Error("ERPNext request failed"),
    attributes: {
      "erpnext.operation": operation,
      "erpnext.error_code": code,
      ...(httpStatus === undefined ? {} : { "erpnext.http_status": httpStatus }),
    },
  })
}
