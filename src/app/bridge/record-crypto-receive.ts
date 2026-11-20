import { WalletCurrency, USDTAmount } from "@domain/shared"

import { listWalletsByAccountId } from "@app/wallets"
import { sendBridgeDepositNotificationBestEffort } from "@app/bridge/send-deposit-notification"

import {
  alertIbexCryptoReceiveFailure,
  alertIbexReconciliationFailed,
} from "@services/alerts/ibex-bridge-movement"
import { reconcileByTxHash } from "@services/bridge/reconciliation"
import {
  promoteBridgeDepositForCryptoReceive,
  writeIbexCryptoReceiveRequest,
} from "@services/frappe/BridgeTransferRequestWriter"
import { LockService } from "@services/lock"
import { baseLogger } from "@services/logger"
import { AccountsRepository } from "@services/mongoose/accounts"
import {
  createIbexCryptoReceive,
  isIbexCryptoReceiveProcessed,
  markIbexCryptoReceiveProcessed,
} from "@services/mongoose/ibex-crypto-receive-log"

export type CryptoReceiveResult =
  | { status: "success" }
  | { status: "already_processed" }
  | { status: "error"; code: CryptoReceiveErrorCode }

export type CryptoReceiveErrorCode =
  | "account_not_found"
  | "wallet_list_failed"
  | "usdt_wallet_not_found"
  | "invalid_amount"
  | "persist_failed"
  | "erpnext_audit_failed"
  | "internal_error"

/**
 * Records a USDT receive on a user's Bridge deposit address (ENG-891): the
 * IBEX receive log, the ERPNext settle row, promotion of the Bridge deposit
 * row to Completed, real-time reconciliation and the user's deposit
 * notification. IBEX has already credited the user; nothing here moves money.
 *
 * One path for every caller: the IBEX Hub webhook and the hourly matcher
 * (match-ibex-deposits.ts). Locked on the tx hash. A receive is marked
 * processed only after every step succeeded, and a processed receive is
 * skipped, so a repeat delivery or run never notifies the user twice while a
 * failed one is retried.
 */
export const recordIbexCryptoReceive = async ({
  txHash,
  address,
  amount,
  currency = "USDT",
  network = "ethereum",
  ibexTransactionId,
  rawPayload,
  notifyUser = true,
}: {
  txHash: string
  address: string
  amount: string | number
  currency?: string
  network?: string
  ibexTransactionId?: string
  rawPayload: unknown
  // False when the credit is old news to the user (a late match).
  notifyUser?: boolean
}): Promise<CryptoReceiveResult | Error> => {
  const normalizedCurrency = String(currency).toUpperCase()
  const normalizedNetwork = String(network).toLowerCase()

  return LockService().lockOnChainTxHash(
    txHash as OnChainTxHash,
    async (): Promise<CryptoReceiveResult> => {
      try {
        const processed = await isIbexCryptoReceiveProcessed(txHash)
        if (processed === true) return { status: "already_processed" }
        if (processed instanceof Error) {
          baseLogger.warn(
            { error: processed, txHash },
            "Could not read IBEX crypto receive state; processing anyway",
          )
        }

        const account = await AccountsRepository().findByBridgeEthereumAddress(address)
        if (account instanceof Error) {
          baseLogger.error({ address, txHash }, "Account not found for Ethereum address")
          alertIbexCryptoReceiveFailure({
            txHash,
            code: "account_not_found",
            title: "IBEX crypto receive: account not found for Bridge Ethereum address",
            context: { address },
          })
          return { status: "error", code: "account_not_found" }
        }

        const ibexLog = await createIbexCryptoReceive({
          txHash,
          address,
          amount: String(amount),
          currency: normalizedCurrency,
          network: normalizedNetwork,
          accountId: account.id,
          ibexTransactionId,
        })
        if (ibexLog instanceof Error) {
          baseLogger.error(
            { error: ibexLog, txHash },
            "Failed to persist IBEX crypto receive log",
          )
          alertIbexCryptoReceiveFailure({
            txHash,
            code: "persist_failed",
            title: "IBEX crypto receive log persistence failed",
            detail: ibexLog.message,
            context: { address },
          })
          return { status: "error", code: "persist_failed" }
        }

        reconcileByTxHash({ txHash }).catch((err) => {
          baseLogger.error({ err, txHash }, "Real-time reconciliation failed")
          alertIbexReconciliationFailed({
            txHash,
            detail: err instanceof Error ? err.message : String(err),
          })
        })

        const wallets = await listWalletsByAccountId(account.id)
        if (wallets instanceof Error) {
          baseLogger.error(
            { accountId: account.id, error: wallets },
            "Failed to list wallets",
          )
          alertIbexCryptoReceiveFailure({
            txHash,
            code: "wallet_list_failed",
            title: "IBEX crypto receive: wallet list failed",
            detail: wallets.message,
            context: { accountId: account.id, address },
          })
          return { status: "error", code: "wallet_list_failed" }
        }

        const usdtWallet = wallets.find((w) => w.currency === WalletCurrency.Usdt)
        if (!usdtWallet) {
          baseLogger.error({ accountId: account.id }, "USDT wallet not found")
          alertIbexCryptoReceiveFailure({
            txHash,
            code: "usdt_wallet_not_found",
            title: "IBEX crypto receive: USDT wallet not found",
            context: { accountId: account.id, address },
          })
          return { status: "error", code: "usdt_wallet_not_found" }
        }

        const usdtAmount = USDTAmount.fromNumber(amount)
        if (usdtAmount instanceof Error) {
          baseLogger.error({ amount, error: usdtAmount }, "Invalid USDT amount")
          alertIbexCryptoReceiveFailure({
            txHash,
            code: "invalid_amount",
            title: "IBEX crypto receive: invalid USDT amount",
            detail: usdtAmount.message,
            context: { accountId: account.id, address, amount },
          })
          return { status: "error", code: "invalid_amount" }
        }

        baseLogger.info(
          {
            accountId: account.id,
            walletId: usdtWallet.id,
            amount: usdtAmount.asNumber(),
            txHash,
            address,
            ibexTransactionId,
          },
          "USDT deposit received",
        )

        const auditResult = await writeIbexCryptoReceiveRequest({
          txHash,
          address,
          amount: String(amount),
          currency: normalizedCurrency,
          network: normalizedNetwork.charAt(0).toUpperCase() + normalizedNetwork.slice(1),
          accountId: account.id,
          walletId: usdtWallet.id,
          rawPayload,
        })
        if (auditResult instanceof Error) {
          baseLogger.error(
            {
              error: auditResult,
              txHash,
              accountId: account.id,
              walletId: usdtWallet.id,
            },
            "Failed to persist IBEX crypto receive ERPNext audit row",
          )
          alertIbexCryptoReceiveFailure({
            txHash,
            code: "erpnext_audit_failed",
            title: "IBEX crypto receive ERPNext audit write failed",
            detail: auditResult.message,
            context: {
              accountId: account.id,
              walletId: usdtWallet.id,
              address,
            },
          })
          return { status: "error", code: "erpnext_audit_failed" }
        }

        // Best-effort: the funds are already credited and the settle row is
        // written, so a promotion failure must not fail the receive. The
        // deposit writer's reverse check (and Bridge webhook retries) will
        // converge the row on a later event.
        const promoteResult = await promoteBridgeDepositForCryptoReceive({
          txHash,
          accountId: account.id,
          walletId: usdtWallet.id,
        })
        if (promoteResult instanceof Error) {
          baseLogger.error(
            { error: promoteResult, txHash, accountId: account.id },
            "Failed to promote Bridge deposit audit row to Completed",
          )
          alertIbexCryptoReceiveFailure({
            txHash,
            code: "erpnext_promote_failed",
            title: "Bridge deposit audit row promotion failed",
            detail: promoteResult.message,
            context: { accountId: account.id, walletId: usdtWallet.id, address },
          })
        } else if (promoteResult === "kept_failed") {
          // Bridge reported this deposit as refunded or failed, yet the USDT
          // arrived and was credited. The row keeps Failed; ops must reconcile.
          baseLogger.error(
            { txHash, accountId: account.id, walletId: usdtWallet.id },
            "Crypto receive credited a Bridge deposit whose audit row is Failed",
          )
          alertIbexCryptoReceiveFailure({
            txHash,
            code: "credited_failed_bridge_deposit",
            title: "USDT credited for a Bridge deposit marked Failed (refunded)",
            detail:
              "The ERPNext row stays Failed. Check with Bridge whether the sender was refunded as well as the customer credited.",
            context: { accountId: account.id, walletId: usdtWallet.id, address },
          })
        } else {
          baseLogger.info(
            { txHash, promoteResult },
            "Bridge deposit audit row promotion result",
          )
        }

        if (notifyUser) {
          await sendBridgeDepositNotificationBestEffort({
            accountId: account.id,
            amount: String(usdtAmount.asNumber()),
            currency: normalizedCurrency,
          })
        }

        const marked = await markIbexCryptoReceiveProcessed(txHash)
        if (marked instanceof Error) {
          // Everything else is done; a repeat may notify the user again.
          baseLogger.warn(
            { error: marked, txHash },
            "Could not mark IBEX crypto receive processed",
          )
        }

        return { status: "success" }
      } catch (error) {
        baseLogger.error({ error, txHash }, "Error processing crypto receive")
        alertIbexCryptoReceiveFailure({
          txHash,
          code: "internal_error",
          title: "IBEX crypto receive processing error",
          detail: error instanceof Error ? error.message : String(error),
        })
        return { status: "error", code: "internal_error" }
      }
    },
  )
}
