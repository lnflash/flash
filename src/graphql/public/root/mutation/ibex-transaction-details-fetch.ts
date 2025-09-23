import { GT } from "@graphql/index"
import IbexClient from "@services/ibex/client"
import { mapError } from "@graphql/error-map"
import { IbexTransactionDetailsPayload } from "@graphql/public/types/payload/ibex-transaction-details"
import { BlockchainService } from "@services/blockchain"

const IbexTransactionDetailsFetchInput = GT.Input({
  name: "IbexTransactionDetailsFetchInput",
  fields: () => ({
    ibexTransactionId: {
      type: GT.NonNull(GT.String),
      description: "Ibex transaction ID to fetch details for",
    },
  }),
})

const IbexTransactionDetailsFetchMutation = GT.Field({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(IbexTransactionDetailsPayload),
  args: {
    input: { type: GT.NonNull(IbexTransactionDetailsFetchInput) },
  },
  resolve: async (_, args) => {
    const { ibexTransactionId } = args.input


    try {
      const transactionDetails = await IbexClient.getTransactionDetails(
        ibexTransactionId as IbexTransactionId,
      )

      if (transactionDetails instanceof Error) {
        return {
          errors: [mapError(transactionDetails)],
        }
      }

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
              confirmations = onchainData.status?.value === "CONFIRMED" ? 6 : 0
            }
          } catch (e) {
            // Fallback to status-based estimation
            confirmations = onchainData.status?.value === "CONFIRMED" ? 6 : 0
          }
        } else {
          // Fallback if no blockheight available
          confirmations =
            onchainData.confirmations ||
            (onchainData.status?.value === "CONFIRMED" ? 6 : 0) ||
            confirmations
        }
      }

      return {
        errors: [],
        transactionDetails: {
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
        },
      }
    } catch (error) {
      return {
        errors: [{ message: "Failed to fetch transaction details" }],
      }
    }
  },
})

export default IbexTransactionDetailsFetchMutation
