import { DeviceTokensNotRegisteredNotificationsServiceError } from "@domain/notifications"
import { WalletCurrency } from "@domain/shared"
import { baseLogger } from "@services/logger"

/**
 * Tell the customer their card top-up landed.
 *
 * Without this, NOTHING notifies a Fygaro payer that money reached their
 * wallet. `creditFygaroTopup` moves the funds through
 * `intraledgerPaymentSendWalletIdForUsdWallet`, which emits no push, and
 * `NotificationsService().intraLedgerTxReceived` had no callers anywhere in
 * `src/` — so the only way to learn the outcome was to have the app open and
 * polling `fygaroTopupStatus`. That poll window is finite and the intent record
 * expires an hour after the JWT, after which the query answers null
 * ("unknown/expired"). The case this closes is the slow credit: a payment whose
 * send only succeeds on a provider retry, minutes or hours after the customer
 * closed the app. The documented client contract says "we'll let you know" for
 * every non-terminal state, and the backend is the only place that promise can
 * be kept from.
 *
 * KNOWN GAP, deliberately out of scope here: HELD_FOR_REVIEW is terminal until
 * a human acts, and the eventual hand-credit does NOT come through this
 * function — it goes through the ordinary intraledger path, which emits no push
 * either. Announcing that resolution means notifying from the send path itself
 * rather than from one caller of it, which is a wider change than this route.
 *
 * DELIBERATELY BEST-EFFORT AND NON-THROWING. It runs after the money has moved
 * and after the ERPNext row has been promoted, on the webhook's money path: a
 * push that cannot be sent is not a reason to fail a delivery whose credit
 * succeeded, because a 500 here asks Fygaro to retry a payment that is already
 * in the customer's wallet. Every failure is logged and swallowed.
 */

// 1 USD = 1,000,000 USDT micros = 100 USD cents.
const USDT_MICROS_PER_USD_CENT = 10_000n

export const notifyFygaroTopupCredited = async ({
  recipientAccount,
  recipientWalletId,
  recipientWalletCurrency,
  netAmountCents,
  transactionId,
}: {
  recipientAccount: Account
  recipientWalletId: WalletId
  recipientWalletCurrency: WalletCurrency
  netAmountCents: number
  transactionId: string
}): Promise<void> => {
  try {
    // Lazy-imported for the same reason `credit-topup.ts` defers
    // `@app/payments/send-intraledger`: the webhook server is its own process,
    // and `@services/notifications` drags in Firebase + the redis pubsub client
    // at module load. Importing that eagerly would pull both into every
    // consumer of this route, including its unit tests.
    const { UsersRepository } = await import("@services/mongoose")
    const { NotificationsService } = await import("@services/notifications")

    const recipientUser = await UsersRepository().findById(recipientAccount.kratosUserId)
    if (recipientUser instanceof Error) {
      baseLogger.warn(
        { transactionId, accountId: recipientAccount.id, error: recipientUser.name },
        "Fygaro credit notification skipped: could not read the recipient user",
      )
      return
    }

    // The amount handed to the send is USD CENTS whatever the wallet's
    // currency — `intraledgerPaymentSendWalletIdForUsdWallet` formats it with
    // `usdCentsDisplay(args.amount)`. The push renderer, though, scales by the
    // currency it is GIVEN (÷100 for USD, ÷1,000,000 for USDT), so handing it
    // cents while naming USDT would announce "$0.0094" for a $9.42 credit.
    // Convert, so the figure on the customer's lock screen is the figure that
    // reached their wallet.
    const amount =
      recipientWalletCurrency === WalletCurrency.Usdt
        ? BigInt(netAmountCents) * USDT_MICROS_PER_USD_CENT
        : BigInt(netAmountCents)

    const result = await NotificationsService().intraLedgerTxReceived({
      recipientAccountId: recipientAccount.id,
      recipientWalletId,
      // NET, not gross: this is what actually landed, and it is the number the
      // status query reports as `netAmount` for the same payment. Announcing
      // the gross would contradict the app's own screen.
      paymentAmount: { amount, currency: recipientWalletCurrency },
      recipientDeviceTokens: recipientUser.deviceTokens,
      recipientNotificationSettings: recipientAccount.notificationSettings,
      recipientLanguage: recipientUser.language,
    })

    if (result instanceof DeviceTokensNotRegisteredNotificationsServiceError) {
      // Same cleanup every other receive path does (send-lightning.ts,
      // add-settled-on-chain-transaction.ts): a token Firebase has rejected is
      // dead, and leaving it on the user makes every future push report a
      // failure.
      const { removeDeviceTokens } = await import("@app/users/remove-device-tokens")
      await removeDeviceTokens({
        userId: recipientUser.id,
        deviceTokens: result.tokens,
      })
      return
    }

    if (result instanceof Error) {
      baseLogger.warn(
        { transactionId, accountId: recipientAccount.id, error: result.name },
        "Fygaro credit notification failed to send",
      )
    }
  } catch (err) {
    baseLogger.warn(
      {
        transactionId,
        accountId: recipientAccount.id,
        error: err instanceof Error ? err.name : String(err),
      },
      "Fygaro credit notification threw; the credit itself is unaffected",
    )
  }
}
