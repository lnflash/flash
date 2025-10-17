import { memoSharingConfig } from "@config"
import { WalletTransactionHistory } from "@domain/wallets"
import { checkedToLedgerTransactionId } from "@domain/ledger"

import { getNonEndUserWalletIds, LedgerService } from "@services/ledger"
import IbexClient from "@services/ibex/client"
import { BlockchainService } from "@services/blockchain"

const DEFAULT_CONFIRMED_BLOCKS = 6

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
  transactionId: string,
): Promise<TransactionDetailsResult | ApplicationError> => {
  try {
    const transactionDetails = await IbexClient.getTransactionDetails(
      transactionId as IbexTransactionId,
    )

    if (transactionDetails instanceof Error) {
      return transactionDetails
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const txDetails = transactionDetails as any

    // Parse currency
    const currency =
      typeof txDetails.currency === "object"
        ? txDetails.currency?.name
        : txDetails.currency

    // Parse transaction type
    const type =
      txDetails.transactionType?.name ||
      (typeof txDetails.type === "object" ? txDetails.type?.name : txDetails.type)

    // Parse status - check various possible locations
    let status = txDetails.status
    if (txDetails.onChainTransaction?.status?.value) {
      status = txDetails.onChainTransaction.status.value
    } else if (typeof txDetails.status === "object") {
      status = txDetails.status?.name || txDetails.status?.value
    }

    // Initialize Lightning fields
    let paymentHash = txDetails.paymentHash
    let paymentPreimage = txDetails.paymentPreimage
    let memo = txDetails.memo
    let bolt11 = txDetails.invoice

    // Parse Lightning invoice if it's an object
    if (typeof txDetails.invoice === "object" && txDetails.invoice !== null) {
      const invoiceObj = txDetails.invoice
      paymentHash = invoiceObj.hash || paymentHash
      paymentPreimage = invoiceObj.preImage || paymentPreimage
      memo = invoiceObj.memo || memo
      bolt11 = invoiceObj.bolt11 || bolt11
    }

    // Parse onchain fields from onChainTransaction object
    let address = txDetails.address
    let txid = txDetails.txid
    let vout = txDetails.vout
    let confirmations = txDetails.confirmations
    let fee = txDetails.fee || txDetails.networkFee || txDetails.onChainSendFee

    // Check for onChainTransaction object (as seen in the logs)
    if (txDetails.onChainTransaction) {
      const onchainData = txDetails.onChainTransaction
      address = onchainData.destAddress || onchainData.address || address
      txid = onchainData.networkTxId || onchainData.txid || txid
      vout = onchainData.vout !== undefined ? onchainData.vout : vout
      fee = onchainData.feeSat || onchainData.fee || fee

      // Calculate confirmations from blockheight
      if (onchainData.blockheight || txDetails.blockheight) {
        const txBlockHeight = onchainData.blockheight || txDetails.blockheight
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
      id: txDetails.id,
      accountId: txDetails.accountId,
      amount: txDetails.amount,
      currency,
      status,
      type,
      createdAt: txDetails.createdAt,
      updatedAt: txDetails.updatedAt,
      invoice: bolt11,
      paymentHash,
      paymentPreimage,
      memo,
      address,
      txid,
      vout,
      confirmations,
      fee,
    }
  } catch (error) {
    console.error("Error fetching transaction details:", {
      transactionId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })

    const errorMessage =
      error instanceof Error
        ? `Failed to fetch transaction details: ${error.message}`
        : "Failed to fetch transaction details due to unknown error"

    return new Error(errorMessage)
  }
}
