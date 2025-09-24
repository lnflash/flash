import { Request, Response } from "express"
import { baseLogger as logger } from "@services/logger"
import { WalletCurrency } from "@domain/shared"

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

export interface TopupWebhookHandler {
  provider: string
  verifySignature(req: Request): boolean
  parsePayload(req: Request): TopupWebhookPayload | Error
  process(payload: TopupWebhookPayload): Promise<void | Error>
}

export abstract class BaseTopupWebhookHandler implements TopupWebhookHandler {
  abstract provider: string

  abstract verifySignature(req: Request): boolean
  abstract parsePayload(req: Request): TopupWebhookPayload | Error

  async process(payload: TopupWebhookPayload): Promise<void | Error> {
    try {
      if (payload.status !== "succeeded") {
        logger.info(
          { provider: this.provider, status: payload.status },
          "Ignoring non-success payment webhook"
        )
        return
      }

      const { AccountsRepository, UsersRepository, WalletsRepository } = await import("@services/mongoose")

      const user = await UsersRepository().findByUsername(payload.username as Username)
      if (user instanceof Error) {
        logger.error({ username: payload.username, error: user }, "User not found for topup payment")
        return user
      }

      const account = await AccountsRepository().findByUserId(user.id)
      if (account instanceof Error) {
        logger.error({ userId: user.id, error: account }, "Account not found")
        return account
      }

      const wallets = await WalletsRepository().findAccountWallets(account.id)
      if (wallets instanceof Error) {
        logger.error({ accountId: account.id, error: wallets }, "Wallets not found")
        return wallets
      }

      const targetWallet = wallets.find(wallet => {
        if (payload.walletType === "BTC") {
          return wallet.currency === WalletCurrency.Btc
        }
        return wallet.currency === WalletCurrency.Usd
      })

      if (!targetWallet) {
        return new Error(`Target wallet not found for ${payload.walletType}`)
      }

      const creditAmount = await this.calculateCreditAmount(payload, targetWallet.currency)
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

      await this.sendNotification({
        user,
        account,
        wallet: targetWallet,
        amount: creditAmount,
        transactionId: result.transactionId,
        originalAmount: payload.amount,
        originalCurrency: payload.currency,
      })

      logger.info(
        {
          provider: this.provider,
          username: payload.username,
          transactionId: payload.transactionId,
          amount: creditAmount,
          currency: targetWallet.currency,
        },
        "Successfully processed topup payment"
      )

    } catch (error) {
      logger.error({ provider: this.provider, error }, "Error processing topup webhook")
      return error as Error
    }
  }

  protected async calculateCreditAmount(
    payload: TopupWebhookPayload,
    targetCurrency: WalletCurrency
  ): Promise<Satoshis | UsdCents | Error> {
    const { toSats } = await import("@domain/bitcoin")
    const { JMDAmount } = await import("@domain/shared")

    if (targetCurrency === WalletCurrency.Btc) {
      if (payload.currency.toUpperCase() === "BTC") {
        return toSats(payload.amount)
      }

      const usdAmount = payload.currency.toUpperCase() === "USD"
        ? payload.amount * 100
        : Math.floor(payload.amount / JMDAmount.dollars(1).value * 100)

      const { PriceService } = await import("@services/price")
      const btcPrice = await PriceService().getCurrentSatPriceInCents()
      if (btcPrice instanceof Error) {
        return btcPrice
      }

      return Math.floor((usdAmount * 100000000) / btcPrice.price) as Satoshis
    } else {
      return payload.currency.toUpperCase() === "USD"
        ? (payload.amount * 100) as UsdCents
        : Math.floor(payload.amount / JMDAmount.dollars(1).value * 100) as UsdCents
    }
  }

  protected async creditAccount(params: {
    accountId: AccountId
    walletId: WalletId
    amount: Satoshis | UsdCents
    transactionId: string
    provider: string
  }): Promise<{ transactionId: string } | Error> {
    // TODO: CRITICAL - Implement actual account crediting logic
    // This is currently just logging the transaction but NOT actually crediting the account
    //
    // Implementation needed:
    // 1. Create an Ibex transaction to credit the wallet
    // 2. Update internal ledger records
    // 3. Store transaction in database for reconciliation
    // 4. Handle idempotency (prevent double credits)
    // 5. Add error handling and rollback mechanism
    //
    // Example implementation might look like:
    // const ibexResult = await Ibex.createTopupTransaction({
    //   walletId: params.walletId,
    //   amount: params.amount,
    //   externalId: params.transactionId,
    //   provider: params.provider
    // })
    //
    // For now, this is a placeholder that just logs the successful webhook receipt

    const { baseLogger as logger } = await import("@services/logger")

    logger.warn({
      provider: params.provider,
      accountId: params.accountId,
      walletId: params.walletId,
      amount: params.amount,
      transactionId: params.transactionId,
      type: "topup_credit"
    }, "⚠️ Topup webhook received but account credit NOT implemented - TODO")

    return { transactionId: params.transactionId }
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

      await NotificationsService().sendTransaction({
        recipient: {
          accountId: params.account.id,
          walletId: params.wallet.id,
          deviceTokens: params.user.deviceTokens,
          notificationSettings: params.account.notificationSettings,
          language: params.user.language,
        },
        transaction: {
          id: params.transactionId,
          amount: params.amount,
          currency: params.wallet.currency,
          type: "topup",
          displayAmount: params.amount,
          settlementDisplayAmount: `${params.originalCurrency} ${params.originalAmount}`,
        },
      })
    } catch (error) {
      logger.warn({ error }, "Failed to send topup notification")
    }
  }

  async handleWebhook(req: Request, resp: Response): Promise<void> {
    try {
      if (!this.verifySignature(req)) {
        logger.warn({ provider: this.provider }, "Invalid webhook signature")
        resp.status(401).send("Unauthorized")
        return
      }

      const payload = this.parsePayload(req)
      if (payload instanceof Error) {
        logger.error({ provider: this.provider, error: payload }, "Failed to parse webhook payload")
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
        "Received topup webhook"
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