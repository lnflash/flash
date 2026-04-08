import express, { Request, Response } from "express"
import { findActiveDepositAddressByAddress } from "@services/mongoose/bridge-deposit-addresses"
import { listWalletsByAccountId } from "@app/wallets"
import { WalletCurrency, USDTAmount } from "@domain/shared"
import { baseLogger } from "@services/logger"
import { LockService } from "@services/lock"
import { authenticate, logRequest } from "../middleware"

const paths = {
  cryptoReceive: "/crypto/receive",
}

const router = express.Router()

interface CryptoReceiveResult {
  status: "success" | "error"
  code?: string
}

const cryptoReceiveHandler = async (req: Request, res: Response) => {
  const { tx_hash, address, amount, currency, network } = req.body

  const normalizedNetwork = String(network || "").toLowerCase()
  if (
    !tx_hash ||
    !address ||
    !amount ||
    String(currency).toUpperCase() !== "USDT" ||
    !(normalizedNetwork === "ethereum" || normalizedNetwork === "erc20")
  ) {
    baseLogger.warn(
      { tx_hash, address, amount, currency, network },
      "Invalid crypto receive payload",
    )
    return res.status(400).json({ error: "Invalid payload" })
  }

  const lockResult = await LockService().lockPaymentHash(tx_hash as any, async () => {
    try {
      const depositAddress = await findActiveDepositAddressByAddress(address)
      if (depositAddress instanceof Error) {
        baseLogger.error({ address, tx_hash }, "Deposit address lookup failed")
        return { status: "error", code: "deposit_address_lookup_failed" } as CryptoReceiveResult
      }
      if (!depositAddress) {
        baseLogger.error({ address, tx_hash }, "Deposit address not found")
        return { status: "error", code: "deposit_address_not_found" } as CryptoReceiveResult
      }

      const wallets = await listWalletsByAccountId(depositAddress.accountId as any)
      if (wallets instanceof Error) {
        baseLogger.error(
          { accountId: depositAddress.accountId, error: wallets },
          "Failed to list wallets",
        )
        return { status: "error", code: "wallet_list_failed" } as CryptoReceiveResult
      }

      const usdtWallet = wallets.find((w) => w.currency === WalletCurrency.Usdt)
      if (!usdtWallet) {
        baseLogger.error({ accountId: depositAddress.accountId }, "USDT wallet not found")
        return { status: "error", code: "usdt_wallet_not_found" } as CryptoReceiveResult
      }

      const usdtAmount = USDTAmount.smallestUnits(amount.toString())
      if (usdtAmount instanceof Error) {
        baseLogger.error({ amount, error: usdtAmount }, "Invalid USDT amount")
        return { status: "error", code: "invalid_amount" } as CryptoReceiveResult
      }

      baseLogger.info(
        {
          accountId: depositAddress.accountId,
          walletId: usdtWallet.id,
          amount: usdtAmount.asNumber(),
          tx_hash,
          address,
          rail: depositAddress.rail,
          currency: depositAddress.currency,
        },
        "USDT deposit received",
      )

      return { status: "success" } as CryptoReceiveResult
    } catch (error) {
      baseLogger.error({ error, tx_hash }, "Error processing crypto receive webhook")
      return { status: "error", code: "internal_error" } as CryptoReceiveResult
    }
  })

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
    deposit_address_lookup_failed: 500,
    deposit_address_not_found: 404,
    wallet_list_failed: 500,
    usdt_wallet_not_found: 404,
    invalid_amount: 400,
    internal_error: 500,
  }

  const statusCode = statusMap[lockResult.code || ""] || 500
  return res.status(statusCode).json({ error: lockResult.code })
}

router.post(paths.cryptoReceive, authenticate, logRequest, cryptoReceiveHandler)

export { paths, router }
