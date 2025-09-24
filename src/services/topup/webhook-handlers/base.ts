import { Request, Response } from "express"
import { baseLogger as logger } from "@services/logger"
import { WalletCurrency } from "@domain/shared"

/**
 * Common payload structure for all topup providers.
 * Each provider-specific handler converts their webhook format to this structure.
 * This allows us to process all providers uniformly in the base handler.
 */
export interface TopupWebhookPayload {
  provider: string
  transactionId: string
  amount: number
  currency: string
  username: string
  walletType?: "USD" | "BTC"
  email?: string
  status: "succeeded" | "failed" | "pending"
  metadata?: Record<string, any>
}

/**
 * Interface that all topup webhook handlers must implement.
 * Each payment provider (Fygaro, Stripe, PayPal) has its own implementation.
 */
export interface TopupWebhookHandler {
  provider: string
  verifySignature(req: Request): boolean // Verify webhook authenticity
  parsePayload(req: Request): TopupWebhookPayload | Error // Convert provider format to common format
  process(payload: TopupWebhookPayload): Promise<void | Error> // Process the payment
  handleWebhook(req: Request, resp: Response): Promise<void> // Main entry point
}

export abstract class BaseTopupWebhookHandler implements TopupWebhookHandler {
  abstract provider: string

  abstract verifySignature(req: Request): boolean
  abstract parsePayload(req: Request): TopupWebhookPayload | Error

  /**
   * Core processing logic for topup webhooks.
   * This method:
   * 1. Validates the payment status
   * 2. Identifies the user from the username in metadata
   * 3. Determines which wallet (USD/BTC) to credit
   * 4. Calculates the credit amount with currency conversion if needed
   * 5. Credits the user's account via Ibex
   * 6. Sends notification to the user
   */
  async process(payload: TopupWebhookPayload): Promise<void | Error> {
    try {
      // Only process successful payments - ignore pending or failed
      if (payload.status !== "succeeded") {
        logger.info(
          { provider: this.provider, status: payload.status },
          "Ignoring non-success payment webhook",
        )
        return
      }

      const { AccountsRepository, WalletsRepository } = await import("@services/mongoose")

      // Find the user account by username from the payment metadata
      // The username must be passed in the payment metadata (client_reference for Fygaro)
      const account = await AccountsRepository().findByUsername(
        payload.username as Username,
      )
      if (account instanceof Error) {
        logger.error(
          { username: payload.username, error: account },
          "User not found for topup payment",
        )
        return account
      }

      const wallets = await WalletsRepository().listByAccountId(account.id)
      if (wallets instanceof Error) {
        logger.error({ accountId: account.id, error: wallets }, "Wallets not found")
        return wallets
      }

      // Determine which wallet to credit based on user's selection
      // walletType is passed in payment metadata (default: USD)
      const targetWallet = wallets.find((wallet) => {
        if (payload.walletType === "BTC") {
          return wallet.currency === WalletCurrency.Btc
        }
        return wallet.currency === WalletCurrency.Usd
      })

      if (!targetWallet) {
        return new Error(`Target wallet not found for ${payload.walletType}`)
      }

      const creditAmount = await this.calculateCreditAmount(
        payload,
        targetWallet.currency,
      )
      if (creditAmount instanceof Error) {
        return creditAmount
      }

      const result = await this.creditAccount({
        accountId: account.id,
        walletId: targetWallet.id,
        amount: creditAmount,
        transactionId: payload.transactionId,
        provider: this.provider,
      })

      if (result instanceof Error) {
        logger.error({ error: result }, "Failed to credit account for topup payment")
        return result
      }

      const { UsersRepository } = await import("@services/mongoose")
      const user = await UsersRepository().findById(account.kratosUserId)
      if (user instanceof Error) {
        logger.error({ error: user }, "Failed to get user for notification")
      } else {
        await this.sendNotification({
          user,
          account,
          wallet: targetWallet,
          amount: creditAmount,
          transactionId: result.transactionId,
          originalAmount: payload.amount,
          originalCurrency: payload.currency,
        })
      }

      logger.info(
        {
          provider: this.provider,
          username: payload.username,
          transactionId: payload.transactionId,
          amount: creditAmount,
          currency: targetWallet.currency,
        },
        "Successfully processed topup payment",
      )
    } catch (error) {
      logger.error({ provider: this.provider, error }, "Error processing topup webhook")
      return error as Error
    }
  }

  /**
   * Calculates the amount to credit based on payment currency and target wallet currency.
   * Handles currency conversions:
   * - USD to BTC: Uses dealer price service for current exchange rate
   * - JMD to USD: Uses configured exchange rate
   * - Direct currency matches: No conversion needed
   */
  protected async calculateCreditAmount(
    payload: TopupWebhookPayload,
    targetCurrency: WalletCurrency,
  ): Promise<Satoshis | UsdCents | Error> {
    const { toSats } = await import("@domain/bitcoin")
    const { JMDAmount } = await import("@domain/shared")

    if (targetCurrency === WalletCurrency.Btc) {
      if (payload.currency.toUpperCase() === "BTC") {
        return toSats(payload.amount)
      }

      const jmdToUsdRate = JMDAmount.dollars(1)
      if (jmdToUsdRate instanceof Error) {
        return jmdToUsdRate
      }

      const usdAmount =
        payload.currency.toUpperCase() === "USD"
          ? payload.amount * 100
          : Math.floor((payload.amount / Number(jmdToUsdRate.asCents())) * 100)

      const { DealerPriceService } = await import("@services/dealer-price")
      const { paymentAmountFromNumber } = await import("@domain/shared")

      const usdPaymentAmount = paymentAmountFromNumber({
        amount: usdAmount,
        currency: "USD",
      })
      if (usdPaymentAmount instanceof Error) {
        return usdPaymentAmount
      }

      const btcResult =
        await DealerPriceService().getSatsFromCentsForImmediateBuy(usdPaymentAmount)
      if (btcResult instanceof Error) {
        return btcResult
      }

      return Number(btcResult.amount) as Satoshis
    } else {
      const jmdToUsdRate = JMDAmount.dollars(1)
      if (jmdToUsdRate instanceof Error) {
        return jmdToUsdRate
      }

      return payload.currency.toUpperCase() === "USD"
        ? ((payload.amount * 100) as UsdCents)
        : (Math.floor(
            (payload.amount / Number(jmdToUsdRate.asCents())) * 100,
          ) as UsdCents)
    }
  }

  /**
   * Credits the user's account with the topup amount.
   * This is the critical section that:
   * 1. Checks for idempotency (prevents double credits)
   * 2. Gets the bank owner wallet (source of funds)
   * 3. Creates an invoice for the user's wallet
   * 4. Pays the invoice from bank owner wallet (via Ibex)
   * 5. Records the transaction in the ledger for accounting
   *
   * NOTE: This requires the bank owner wallet to be configured and funded.
   * The bank owner wallet is Flash's operational wallet used for both
   * cashouts (user → bank owner) and topups (bank owner → user).
   */
  protected async creditAccount(params: {
    accountId: AccountId
    walletId: WalletId
    amount: Satoshis | UsdCents
    transactionId: string
    provider: string
  }): Promise<{ transactionId: string } | Error> {
    const { baseLogger: logger } = await import("@services/logger")
    const { recordTopup, getTopupTransactionByExternalId } = await import(
      "@services/ledger/topup"
    )
    const Ibex = await import("@services/ibex/client").then((m) => m.default)
    const { USDAmount } = await import("@domain/shared")

    try {
      // 1. IDEMPOTENCY CHECK - Critical for preventing double credits
      // Each external transaction ID can only be processed once
      // This protects against duplicate webhooks or replay attacks
      const existingTransaction = await getTopupTransactionByExternalId(
        params.transactionId,
        params.provider,
      )

      if (existingTransaction && existingTransaction.length > 0) {
        logger.info(
          {
            provider: params.provider,
            transactionId: params.transactionId,
          },
          "Topup transaction already processed - idempotency check",
        )

        return { transactionId: params.transactionId }
      }

      // 2. GET BANK OWNER WALLET - This is Flash's central operational wallet
      // Same wallet used for cashouts but in reverse:
      // - Cashout: User wallet → Bank owner wallet → External bank
      // - Topup: External payment → Bank owner wallet → User wallet
      let bankOwnerWalletId: WalletId
      try {
        const { getBankOwnerWalletId } = await import("@services/ledger/caching")
        bankOwnerWalletId = await getBankOwnerWalletId()
      } catch (error) {
        logger.error({ error }, "Failed to get bank owner wallet")
        return error instanceof Error ? error : new Error(String(error))
      }

      // 3. PROCESS CREDIT VIA IBEX
      // Ibex handles the actual Lightning Network transactions
      // We create an invoice for the user and pay it from bank owner wallet
      // TODO: Handle BTC wallets properly (currently assumes USD)
      const usdCents = params.amount as UsdCents
      const amount = USDAmount.cents(usdCents.toString())
      if (amount instanceof Error) {
        logger.error({ error: amount }, "Failed to convert amount")
        return amount
      }

      // Create an invoice for the user's wallet
      const invoiceResult = await Ibex.addInvoice({
        accountId: params.walletId,
        amount,
        memo: `${params.provider} topup ${params.transactionId}`,
      })

      if (invoiceResult instanceof Error) {
        logger.error({ error: invoiceResult }, "Failed to create invoice for topup")
        return invoiceResult
      }

      if (!invoiceResult.invoice?.bolt11) {
        return new Error("Failed to get invoice bolt11")
      }

      // Pay the invoice from the bank owner wallet
      const paymentResult = await Ibex.payInvoice({
        accountId: bankOwnerWalletId,
        invoice: invoiceResult.invoice.bolt11 as Bolt11,
      })

      if (paymentResult instanceof Error) {
        logger.error({ error: paymentResult }, "Failed to pay topup invoice")
        return paymentResult
      }

      // 4. LEDGER RECORDING - Double-entry bookkeeping for accounting
      // Records the flow: External Provider → Bank Owner → User Wallet
      // This ensures proper financial tracking and reconciliation
      const ledgerResult = await recordTopup({
        recipientWalletId: params.walletId,
        bankOwnerWalletId,
        amount: params.amount,
        currency: WalletCurrency.Usd,
        provider: params.provider as "fygaro" | "stripe" | "paypal",
        externalTransactionId: params.transactionId,
      })

      if (ledgerResult instanceof Error) {
        logger.error({ error: ledgerResult }, "Failed to record topup in ledger")
        // CRITICAL: At this point the Ibex transaction succeeded but ledger failed
        // This creates a reconciliation issue - money was moved but not recorded
        // TODO: Implement proper error recovery or compensation transaction
        // In production, this should trigger an alert for manual reconciliation
      }

      logger.info(
        {
          provider: params.provider,
          accountId: params.accountId,
          walletId: params.walletId,
          amount: params.amount,
          transactionId: params.transactionId,
          ibexInvoiceId: invoiceResult.invoice.id,
          ibexPaymentStatus: paymentResult.status,
          type: "topup_credit",
        },
        "✅ Topup successfully credited to user wallet",
      )

      return { transactionId: params.transactionId }
    } catch (error) {
      logger.error(
        {
          provider: params.provider,
          accountId: params.accountId,
          walletId: params.walletId,
          amount: params.amount,
          transactionId: params.transactionId,
          error,
        },
        "Failed to credit topup to user wallet",
      )

      return error as Error
    }
  }

  protected async sendNotification(params: {
    user: User
    account: Account
    wallet: Wallet
    amount: Satoshis | UsdCents
    transactionId: string
    originalAmount: number
    originalCurrency: string
  }): Promise<void> {
    try {
      const { NotificationsService } = await import("@services/notifications")

      // Use intraLedgerTxReceived for topup notifications
      await NotificationsService().intraLedgerTxReceived({
        recipientAccountId: params.account.id,
        recipientWalletId: params.wallet.id,
        paymentAmount: {
          amount: BigInt(params.amount),
          currency: params.wallet.currency,
        },
        recipientDeviceTokens: params.user.deviceTokens,
        recipientNotificationSettings: params.account.notificationSettings,
        recipientLanguage: params.user.language,
      })
    } catch (error) {
      logger.warn({ error }, "Failed to send topup notification")
    }
  }

  /**
   * Main entry point for webhook processing.
   * Handles the HTTP request/response cycle:
   * 1. Verifies webhook signature (if provider supplies one)
   * 2. Parses the webhook payload
   * 3. Processes the payment
   * 4. Returns appropriate HTTP response
   */
  async handleWebhook(req: Request, resp: Response): Promise<void> {
    try {
      // Security: Verify the webhook is from the claimed provider
      // Some providers (like Fygaro) may not provide signatures
      if (!this.verifySignature(req)) {
        logger.warn({ provider: this.provider }, "Invalid webhook signature")
        resp.status(401).send("Unauthorized")
        return
      }

      const payload = this.parsePayload(req)
      if (payload instanceof Error) {
        logger.error(
          { provider: this.provider, error: payload },
          "Failed to parse webhook payload",
        )
        resp.status(400).send("Bad request")
        return
      }

      logger.info(
        {
          provider: this.provider,
          transactionId: payload.transactionId,
          amount: payload.amount,
          username: payload.username,
        },
        "Received topup webhook",
      )

      const result = await this.process(payload)
      if (result instanceof Error) {
        resp.status(500).send("Internal server error")
        return
      }

      resp.status(200).send("OK")
    } catch (error) {
      logger.error({ provider: this.provider, error }, "Error handling topup webhook")
      resp.status(500).send("Internal server error")
    }
  }
}
