import express, { Request, Response } from "express"
import rateLimitMiddleware from "express-rate-limit"
import { AccountsRepository } from "@services/mongoose/accounts"
import { createIbexCryptoReceive } from "@services/mongoose/ibex-crypto-receive-log"
import { listWalletsByAccountId } from "@app/wallets"
import { sendBridgeDepositNotificationBestEffort } from "@app/bridge/send-deposit-notification"
import { WalletCurrency, USDTAmount } from "@domain/shared"
import { baseLogger } from "@services/logger"
import { LockService } from "@services/lock"
import { reconcileByTxHash } from "@services/bridge/reconciliation"
import {
  alertIbexCryptoReceiveFailure,
  alertIbexReconciliationFailed,
} from "@services/alerts/ibex-bridge-movement"
import { writeIbexCryptoReceiveRequest } from "@services/frappe/BridgeTransferRequestWriter"
import { ibexWebhookPaths } from "@services/ibex/webhook-config"

import { authenticate, logRequest, validateIbexIp } from "../middleware"

const paths = ibexWebhookPaths.cryptoReceive

const router = express.Router()

const webhookRateLimit = rateLimitMiddleware({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
})

interface CryptoReceiveResult {
  status: "success" | "error"
  code?: string
}

const cryptoReceiveHandler = async (req: Request, res: Response) => {
  const { tx_hash, address, amount, currency, network } = req.body
  const normalizedCurrency = String(currency || "").toUpperCase()
  const normalizedNetwork = String(network || "").toLowerCase()

  if (
    !tx_hash ||
    !address ||
    !amount ||
    normalizedCurrency !== "USDT" ||
    normalizedNetwork !== "ethereum"
  ) {
    baseLogger.warn(
      { tx_hash, address, amount, currency, network },
      "Invalid crypto receive payload",
    )
    return res.status(400).json({ error: "Invalid payload" })
  }

  const lockResult = await LockService().lockOnChainTxHash(
    tx_hash as OnChainTxHash,
    async () => {
      try {
        const account = await AccountsRepository().findByBridgeEthereumAddress(address)
        if (account instanceof Error) {
          baseLogger.error({ address, tx_hash }, "Account not found for Ethereum address")
          alertIbexCryptoReceiveFailure({
            txHash: String(tx_hash),
            code: "account_not_found",
            title: "IBEX crypto receive: account not found for Bridge Ethereum address",
            context: { address },
          })
          return { status: "error", code: "account_not_found" } as CryptoReceiveResult
        }

        const ibexLog = await createIbexCryptoReceive({
          txHash: String(tx_hash),
          address: String(address),
          amount: String(amount),
          currency: normalizedCurrency,
          network: normalizedNetwork,
          accountId: account.id,
        })
        if (ibexLog instanceof Error) {
          baseLogger.error(
            { error: ibexLog, tx_hash },
            "Failed to persist IBEX crypto receive log",
          )
          alertIbexCryptoReceiveFailure({
            txHash: String(tx_hash),
            code: "persist_failed",
            title: "IBEX crypto receive log persistence failed",
            detail: ibexLog.message,
            context: { address },
          })
          return { status: "error", code: "internal_error" } as CryptoReceiveResult
        }

        reconcileByTxHash({ txHash: String(tx_hash) }).catch((err) => {
          baseLogger.error({ err, tx_hash }, "Real-time reconciliation failed")
          alertIbexReconciliationFailed({
            txHash: String(tx_hash),
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
            txHash: String(tx_hash),
            code: "wallet_list_failed",
            title: "IBEX crypto receive: wallet list failed",
            detail: wallets.message,
            context: { accountId: account.id, address },
          })
          return { status: "error", code: "wallet_list_failed" } as CryptoReceiveResult
        }

        const usdtWallet = wallets.find((w) => w.currency === WalletCurrency.Usdt)
        if (!usdtWallet) {
          baseLogger.error({ accountId: account.id }, "USDT wallet not found")
          alertIbexCryptoReceiveFailure({
            txHash: String(tx_hash),
            code: "usdt_wallet_not_found",
            title: "IBEX crypto receive: USDT wallet not found",
            context: { accountId: account.id, address },
          })
          return { status: "error", code: "usdt_wallet_not_found" } as CryptoReceiveResult
        }

        const usdtAmount = USDTAmount.fromNumber(amount)
        if (usdtAmount instanceof Error) {
          baseLogger.error({ amount, error: usdtAmount }, "Invalid USDT amount")
          alertIbexCryptoReceiveFailure({
            txHash: String(tx_hash),
            code: "invalid_amount",
            title: "IBEX crypto receive: invalid USDT amount",
            detail: usdtAmount.message,
            context: { accountId: account.id, address, amount },
          })
          return { status: "error", code: "invalid_amount" } as CryptoReceiveResult
        }

        baseLogger.info(
          {
            accountId: account.id,
            walletId: usdtWallet.id,
            amount: usdtAmount.asNumber(),
            tx_hash,
            address,
          },
          "USDT deposit received",
        )

        const auditResult = await writeIbexCryptoReceiveRequest({
          txHash: String(tx_hash),
          address: String(address),
          amount: String(amount),
          currency: normalizedCurrency,
          network: normalizedNetwork.charAt(0).toUpperCase() + normalizedNetwork.slice(1),
          accountId: account.id,
          walletId: usdtWallet.id,
          rawPayload: req.body,
        })
        if (auditResult instanceof Error) {
          baseLogger.error(
            {
              error: auditResult,
              tx_hash,
              accountId: account.id,
              walletId: usdtWallet.id,
            },
            "Failed to persist IBEX crypto receive ERPNext audit row",
          )
          alertIbexCryptoReceiveFailure({
            txHash: String(tx_hash),
            code: "erpnext_audit_failed",
            title: "IBEX crypto receive ERPNext audit write failed",
            detail: auditResult.message,
            context: {
              accountId: account.id,
              walletId: usdtWallet.id,
              address,
            },
          })
          return { status: "error", code: "erpnext_audit_failed" } as CryptoReceiveResult
        }

        await sendBridgeDepositNotificationBestEffort({
          accountId: account.id,
          amount: String(usdtAmount.asNumber()),
          currency: normalizedCurrency,
        })

        return { status: "success" } as CryptoReceiveResult
      } catch (error) {
        baseLogger.error({ error, tx_hash }, "Error processing crypto receive webhook")
        alertIbexCryptoReceiveFailure({
          txHash: String(tx_hash),
          code: "internal_error",
          title: "IBEX crypto receive webhook processing error",
          detail: error instanceof Error ? error.message : String(error),
        })
        return { status: "error", code: "internal_error" } as CryptoReceiveResult
      }
    },
  )

  if (lockResult instanceof Error) {
    baseLogger.warn(
      { tx_hash, error: lockResult },
      "Lock acquisition failed or duplicate webhook",
    )
    return res.status(200).json({ status: "already_processed" })
  }

  if (lockResult.status === "success") {
    return res.status(200).json({ status: "success" })
  }

  const statusMap: Record<string, number> = {
    account_not_found: 404,
    wallet_list_failed: 500,
    usdt_wallet_not_found: 404,
    invalid_amount: 400,
    erpnext_audit_failed: 500,
    internal_error: 500,
  }

  const statusCode = statusMap[lockResult.code || ""] || 500
  return res.status(statusCode).json({ error: lockResult.code })
}

router.post(
  paths.cryptoReceive,
  webhookRateLimit,
  validateIbexIp,
  authenticate,
  logRequest,
  cryptoReceiveHandler,
)

export { cryptoReceiveHandler, paths, router }
