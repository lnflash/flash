import { memoSharingConfig } from "@config"
import { WalletTransactionHistory } from "@domain/wallets"
import { checkedToLedgerTransactionId } from "@domain/ledger"

import { getNonEndUserWalletIds, LedgerService } from "@services/ledger"
import IbexClient from "@services/ibex/client"
import { BlockchainService } from "@services/blockchain"
import { baseLogger } from "@services/logger"
import { recordExceptionInCurrentSpan } from "@services/tracing"
import { ErrorLevel } from "@domain/shared"

const DEFAULT_CONFIRMED_BLOCKS = 6

// Helper type for raw Ibex transaction data
type RawIbexTransaction = {
  id: string
  accountId: string
  amount: number
  createdAt: string
  updatedAt: string
  currency?: string | { name?: string }
  transactionType?: { name?: string }
  type?: string | { name?: string }
  status?: string | { name?: string; value?: string }
  paymentHash?: string
  paymentPreimage?: string
  memo?: string
  invoice?: string | {
    hash?: string
    preImage?: string
    memo?: string
    bolt11?: string
  }
  address?: string
  txid?: string
  vout?: number
  confirmations?: number
  fee?: number
  networkFee?: number
  onChainSendFee?: number
  blockheight?: number
  onChainTransaction?: {
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
}

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
const parseTransactionMetadata = (txDetails: RawIbexTransaction): ParsedMetadata => {
  // Parse currency
  const currency =
    typeof txDetails.currency === "object"
      ? txDetails.currency?.name || ""
      : txDetails.currency || ""

  // Parse transaction type
  const type =
    txDetails.transactionType?.name ||
    (typeof txDetails.type === "object" ? txDetails.type?.name : txDetails.type) ||
    ""

  // Parse status - check various possible locations
  let status = txDetails.status || ""
  if (txDetails.onChainTransaction?.status?.value) {
    status = txDetails.onChainTransaction.status.value
  } else if (typeof txDetails.status === "object") {
    status = txDetails.status?.name || txDetails.status?.value || ""
  }

  return { currency, type, status: String(status) }
}

/**
 * Parses Lightning-specific fields from raw Ibex data
 */
const parseLightningFields = (txDetails: RawIbexTransaction): ParsedLightningFields => {
  let paymentHash = txDetails.paymentHash
  let paymentPreimage = txDetails.paymentPreimage
  let memo = txDetails.memo
  let bolt11: string | undefined =
    typeof txDetails.invoice === "string" ? txDetails.invoice : undefined

  // Parse Lightning invoice if it's an object
  if (typeof txDetails.invoice === "object" && txDetails.invoice !== null) {
    const invoiceObj = txDetails.invoice
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
  txDetails: RawIbexTransaction,
): Promise<ParsedOnChainFields> => {
  let address = txDetails.address
  let txid = txDetails.txid
  let vout = txDetails.vout
  let confirmations = txDetails.confirmations
  let fee = txDetails.fee || txDetails.networkFee || txDetails.onChainSendFee

  // Check for onChainTransaction object
  if (txDetails.onChainTransaction) {
    const onchainData = txDetails.onChainTransaction
    address = onchainData.destAddress || onchainData.address || address
    txid = onchainData.networkTxId || onchainData.txid || txid
    vout = onchainData.vout !== undefined ? onchainData.vout : vout
    fee = onchainData.feeSat || onchainData.fee || fee

    // Calculate confirmations from blockheight
    if (onchainData.blockheight !== undefined || txDetails.blockheight !== undefined) {
      const txBlockHeight = onchainData.blockheight ?? txDetails.blockheight ?? 0
      try {
        const currentBlockHeight = await BlockchainService.getCurrentBlockHeight()
        if (!(currentBlockHeight instanceof Error)) {
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
      baseLogger.warn(
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
    const txDetails = transactionDetails as RawIbexTransaction

    // Parse transaction data using helper functions
    const metadata = parseTransactionMetadata(txDetails)
    const lightningFields = parseLightningFields(txDetails)
    const onChainFields = await parseOnChainFields(txDetails)

    const result: TransactionDetailsResult = {
      id: txDetails.id,
      accountId: txDetails.accountId,
      amount: txDetails.amount,
      currency: metadata.currency,
      status: metadata.status,
      type: metadata.type,
      createdAt: txDetails.createdAt,
      updatedAt: txDetails.updatedAt,
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
