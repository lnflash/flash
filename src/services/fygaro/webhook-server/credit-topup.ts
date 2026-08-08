import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { WalletCurrency } from "@domain/shared"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import { baseLogger } from "@services/logger"

/**
 * Credits a verified Fygaro card payment to the payer's Flash account:
 * an intraledger USD send from the bank-owner treasury to the user's cash
 * wallet. Mirrors the referral-reward payout path (award-referral-reward.ts),
 * the in-repo precedent for treasury -> user credits.
 *
 * Safety properties:
 *  - The send runs under withPaymentIdempotency keyed on the Fygaro
 *    transaction id, so a webhook replay can never double-credit (ENG-530).
 *  - PaymentSendStatus.Pending means money has probably left the treasury —
 *    it is reported as credited (never retried) and left to ops to confirm,
 *    the same never-risk-a-double-pay stance the referral payout takes.
 */
const TREASURY_ROLE = "bankowner"

export class FygaroCreditError extends Error {
  step: string
  constructor(step: string, message: string) {
    super(message)
    this.name = "FygaroCreditError"
    this.step = step
  }
}

const walletsFor = async (accountId: AccountId): Promise<Wallet[]> => {
  const wallets = await WalletsRepository().listByAccountId(accountId)
  return wallets instanceof Error ? [] : wallets
}

export const creditFygaroTopup = async ({
  recipientAccountId,
  amountCents,
  transactionId,
}: {
  recipientAccountId: AccountId
  amountCents: number
  transactionId: string
}): Promise<
  { walletId: WalletId; status: "success" | "pending" } | FygaroCreditError
> => {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return new FygaroCreditError("validate-amount", `invalid amount: ${amountCents}`)
  }

  const treasuryAccount = await AccountsRepository().findByRole(TREASURY_ROLE)
  if (treasuryAccount instanceof Error) {
    return new FygaroCreditError(
      "resolve-treasury",
      `no account holds the '${TREASURY_ROLE}' role`,
    )
  }

  // Prefer the USDT wallet (the active cash wallet on every account — see
  // accounts/create-account.ts), falling back to the legacy USD wallet.
  const treasuryWallets = await walletsFor(treasuryAccount.id)
  const fundingWallet =
    treasuryWallets.find((w) => w.currency === WalletCurrency.Usdt) ??
    treasuryWallets.find((w) => w.currency === WalletCurrency.Usd)
  if (!fundingWallet) {
    return new FygaroCreditError(
      "resolve-treasury-wallet",
      "treasury account has no USDT or USD wallet",
    )
  }

  // Recipients must hold a wallet in the funding wallet's currency —
  // send-intraledger rejects cross-currency sends.
  const recipientWallet = (await walletsFor(recipientAccountId)).find(
    (w) => w.currency === fundingWallet.currency,
  )
  if (!recipientWallet) {
    return new FygaroCreditError(
      "resolve-recipient-wallet",
      `recipient has no ${fundingWallet.currency} wallet`,
    )
  }

  // Lazy-import so merely importing this module doesn't pull the IBEX client
  // (and its module-load side effects) into unrelated code paths.
  const { intraledgerPaymentSendWalletIdForUsdWallet } = await import(
    "@app/payments/send-intraledger"
  )
  const result = await intraledgerPaymentSendWalletIdForUsdWallet({
    senderWalletId: fundingWallet.id,
    recipientWalletId: recipientWallet.id,
    amount: amountCents,
    memo: `Card top-up (Fygaro ${transactionId})`,
    idempotencyKey: `fygaro:${transactionId}` as IdempotencyKey,
  })

  if (result instanceof Error) {
    baseLogger.error(
      { err: result, transactionId, recipientAccountId },
      "fygaro credit: intraledger send returned an error",
    )
    return new FygaroCreditError("intraledger-send", result.message)
  }
  if (result === PaymentSendStatus.Success) {
    return { walletId: recipientWallet.id, status: "success" }
  }
  if (result === PaymentSendStatus.Pending) {
    // Money has probably left the treasury: report credited, never re-pay.
    baseLogger.warn(
      { transactionId, recipientAccountId },
      "fygaro credit: send pending — treating as credited for idempotency",
    )
    return { walletId: recipientWallet.id, status: "pending" }
  }
  return new FygaroCreditError(
    "intraledger-send",
    `unexpected payment status: ${String(result)}`,
  )
}
