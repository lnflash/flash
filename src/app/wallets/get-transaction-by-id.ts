import { memoSharingConfig } from "@config"
import { WalletTransactionHistory } from "@domain/wallets"
import { checkedToLedgerTransactionId } from "@domain/ledger"

import { getNonEndUserWalletIds, LedgerService } from "@services/ledger"
import IbexClient from "@services/ibex/client"
import { BlockchainService } from "@services/blockchain"
import { baseLogger } from "@services/logger"
import { recordExceptionInCurrentSpan } from "@services/tracing"
import { ErrorLevel } from "@domain/shared"
import { GetTransactionDetails1Response200 } from "ibex-client"

const DEFAULT_CONFIRMED_BLOCKS = 6

type ParsedMetadata = {
  currency: string
  type: string
  status: string
}

type ParsedLightningFields = {
  paymentHash?: string
  paymentPreimage?: string
  memo?: string
  invoice?: string
}

type ParsedOnChainFields = {
  address?: string
  txid?: string
  vout?: number
  confirmations?: number
  fee?: number
}

export type TransactionDetailsResult = {
  id: string
  accountId: string
  amount: number
  currency: string
  status: string
  type: string
  createdAt: string
  updatedAt: string
  invoice?: string
  paymentHash?: string
  paymentPreimage?: string
  memo?: string
  address?: string
  txid?: string
  vout?: number
  confirmations?: number
  fee?: number
}

/**
 * Parses transaction metadata (currency, type, status) from raw Ibex data
 */
const parseTransactionMetadata = (
  txDetails: GetTransactionDetails1Response200,
): ParsedMetadata => {
  // Parse currency - handle the actual API response structure
  const currency =
    typeof txDetails.currency === "object" &&
    txDetails.currency &&
    "name" in txDetails.currency
      ? (txDetails.currency as { name?: string }).name || ""
      : typeof txDetails.currency === "string"
        ? txDetails.currency
        : ""

  // Parse transaction type
  const type =
    typeof txDetails.transactionType === "object" &&
    txDetails.transactionType &&
    "name" in txDetails.transactionType
      ? (txDetails.transactionType as { name?: string }).name || ""
      : typeof txDetails.type === "object" && txDetails.type && "name" in txDetails.type
        ? (txDetails.type as { name?: string }).name || ""
        : typeof txDetails.type === "string"
          ? txDetails.type
          : ""

  // Parse status - check various possible locations
  let status = ""
  if (
    txDetails.onChainTransaction &&
    typeof txDetails.onChainTransaction === "object" &&
    "status" in txDetails.onChainTransaction &&
    typeof txDetails.onChainTransaction.status === "object" &&
    txDetails.onChainTransaction.status &&
    "value" in txDetails.onChainTransaction.status
  ) {
    status = String(
      (txDetails.onChainTransaction.status as { value?: string }).value || "",
    )
  } else if (typeof txDetails.status === "object" && txDetails.status) {
    if ("name" in txDetails.status) {
      status = String((txDetails.status as { name?: string }).name || "")
    } else if ("value" in txDetails.status) {
      status = String((txDetails.status as { value?: string }).value || "")
    }
  } else if (typeof txDetails.status === "string") {
    status = txDetails.status
  }

  return { currency, type, status }
}

/**
 * Parses Lightning-specific fields from raw Ibex data
 */
const parseLightningFields = (
  txDetails: GetTransactionDetails1Response200,
): ParsedLightningFields => {
  let paymentHash =
    typeof txDetails.paymentHash === "string" ? txDetails.paymentHash : undefined
  let paymentPreimage =
    typeof txDetails.paymentPreimage === "string" ? txDetails.paymentPreimage : undefined
  let memo = typeof txDetails.memo === "string" ? txDetails.memo : undefined
  let bolt11: string | undefined =
    typeof txDetails.invoice === "string" ? txDetails.invoice : undefined

  // Parse Lightning invoice if it's an object
  if (typeof txDetails.invoice === "object" && txDetails.invoice !== null) {
    const invoiceObj = txDetails.invoice as {
      hash?: string
      preImage?: string
      memo?: string
      bolt11?: string
    }
    paymentHash = invoiceObj.hash || paymentHash
    paymentPreimage = invoiceObj.preImage || paymentPreimage
    memo = invoiceObj.memo || memo
    bolt11 = invoiceObj.bolt11 || bolt11
  }

  return {
    paymentHash,
    paymentPreimage,
    memo,
    invoice: bolt11,
  }
}

/**
 * Parses onchain-specific fields from raw Ibex data
 */
const parseOnChainFields = async (
  txDetails: GetTransactionDetails1Response200,
): Promise<ParsedOnChainFields> => {
  let address = typeof txDetails.address === "string" ? txDetails.address : undefined
  let txid = typeof txDetails.txid === "string" ? txDetails.txid : undefined
  let vout = typeof txDetails.vout === "number" ? txDetails.vout : undefined
  let confirmations =
    typeof txDetails.confirmations === "number" ? txDetails.confirmations : undefined
  let fee =
    typeof txDetails.fee === "number"
      ? txDetails.fee
      : typeof txDetails.networkFee === "number"
        ? txDetails.networkFee
        : typeof txDetails.onChainSendFee === "number"
          ? txDetails.onChainSendFee
          : undefined

  // Check for onChainTransaction object
  if (txDetails.onChainTransaction && typeof txDetails.onChainTransaction === "object") {
    const onchainData = txDetails.onChainTransaction as {
      destAddress?: string
      address?: string
      networkTxId?: string
      txid?: string
      vout?: number
      feeSat?: number
      fee?: number
      blockheight?: number
      confirmations?: number
      status?: { value?: string }
    }

    address = onchainData.destAddress || onchainData.address || address
    txid = onchainData.networkTxId || onchainData.txid || txid
    vout = onchainData.vout !== undefined ? onchainData.vout : vout
    fee = onchainData.feeSat || onchainData.fee || fee

    // Calculate confirmations from blockheight
    const txBlockHeight =
      onchainData.blockheight ??
      (typeof txDetails.blockheight === "number" ? txDetails.blockheight : undefined)

    if (txBlockHeight !== undefined) {
      try {
        const currentBlockHeight = await BlockchainService.getCurrentBlockHeight()
        if (
          !(currentBlockHeight instanceof Error) &&
          typeof currentBlockHeight === "number"
        ) {
          confirmations = currentBlockHeight - txBlockHeight
        } else {
          // Fallback to status-based estimation if API call fails
          confirmations =
            onchainData.status?.value === "CONFIRMED" ? DEFAULT_CONFIRMED_BLOCKS : 0
        }
      } catch (e) {
        // Fallback to status-based estimation
        confirmations =
          onchainData.status?.value === "CONFIRMED" ? DEFAULT_CONFIRMED_BLOCKS : 0
      }
    } else {
      // Fallback if no blockheight available
      confirmations =
        onchainData.confirmations ||
        (onchainData.status?.value === "CONFIRMED" ? DEFAULT_CONFIRMED_BLOCKS : 0) ||
        confirmations
    }
  }

  return {
    address,
    txid,
    vout,
    confirmations,
    fee,
  }
}

export const getTransactionById = async (
  id: string,
): Promise<WalletTransaction | ApplicationError> => {
  const ledger = LedgerService()

  const ledgerTxId = checkedToLedgerTransactionId(id)
  if (ledgerTxId instanceof Error) return ledgerTxId

  const ledgerTransaction = await ledger.getTransactionById(ledgerTxId)
  if (ledgerTransaction instanceof Error) return ledgerTransaction

  return WalletTransactionHistory.fromLedger({
    ledgerTransactions: [ledgerTransaction],
    nonEndUserWalletIds: Object.values(await getNonEndUserWalletIds()),
    memoSharingConfig,
  }).transactions[0]
}

export const getTransactionDetailsById = async (
  transactionId: IbexTransactionId,
): Promise<TransactionDetailsResult | ApplicationError> => {
  try {
    const transactionDetails = await IbexClient.getTransactionDetails(transactionId)

    if (transactionDetails instanceof Error) {
      baseLogger.error(
        { transactionId, error: transactionDetails.message },
        "Failed to fetch transaction details from Ibex",
      )
      recordExceptionInCurrentSpan({
        error: transactionDetails,
        level: ErrorLevel.Warn,
        attributes: { transactionId },
      })
      return transactionDetails
    }

    // Cast to our structured type instead of any
    const txDetails = transactionDetails as GetTransactionDetails1Response200

    // Parse transaction data using helper functions
    const metadata = parseTransactionMetadata(txDetails)
    const lightningFields = parseLightningFields(txDetails)
    const onChainFields = await parseOnChainFields(txDetails)

    const result: TransactionDetailsResult = {
      id: txDetails.id || "",
      accountId: txDetails.accountId || "",
      amount: txDetails.amount || 0,
      currency: metadata.currency,
      status: metadata.status,
      type: metadata.type,
      createdAt: txDetails.createdAt || "",
      updatedAt: typeof txDetails.updatedAt === "string" ? txDetails.updatedAt : "",
      invoice: lightningFields.invoice,
      paymentHash: lightningFields.paymentHash,
      paymentPreimage: lightningFields.paymentPreimage,
      memo: lightningFields.memo,
      address: onChainFields.address,
      txid: onChainFields.txid,
      vout: onChainFields.vout,
      confirmations: onChainFields.confirmations,
      fee: onChainFields.fee,
    }

    return result
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? `Failed to fetch transaction details: ${error.message}`
        : "Failed to fetch transaction details due to unknown error"

    baseLogger.error(
      {
        transactionId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      errorMessage,
    )

    recordExceptionInCurrentSpan({
      error: error instanceof Error ? error : new Error(String(error)),
      level: ErrorLevel.Critical,
      attributes: { transactionId },
    })

    return new Error(errorMessage)
  }
}
