import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { WalletCurrency } from "@domain/shared"
import { InsufficientBalanceError } from "@domain/errors"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import { baseLogger } from "@services/logger"
import { InsufficientIbexBalance } from "@services/ibex/errors"

// The treasury can't cover the send. On the flash IBEX-custodial path an
// under-funded bankowner surfaces as InsufficientIbexBalance (ibex/errors.ts
// maps the IBEX "insufficient balance" ApiError); InsufficientBalanceError is
// the domain-level equivalent kept for defence in depth. Matched by class, not
// by message, so a generic send error with a coincidental wording is NOT
// misread as float exhaustion.
const isInsufficientTreasuryBalance = (err: Error): boolean =>
  err instanceof InsufficientIbexBalance || err instanceof InsufficientBalanceError

/** Distinct credit-failure step signalling the treasury float is exhausted. */
export const INSUFFICIENT_TREASURY_FLOAT_STEP = "insufficient-treasury-float"

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

export type FygaroTreasuryFunding = {
  account: Account
  fundingWallet: Wallet
}

/**
 * Resolves the bankowner treasury account and the exact wallet auto-credit
 * spends from: the USDT cash wallet on every account (see
 * accounts/create-account.ts), falling back to the legacy USD wallet.
 *
 * This is the SINGLE source of truth for treasury funding-wallet selection.
 * Both the credit path (creditFygaroTopup, below) and the proactive float
 * monitor (float-monitor.ts) resolve the funding wallet through here, so the
 * monitor can never silently drift onto a different wallet than the one credits
 * actually drain — the round-1 "monitor the exact wallet auto-credit spends
 * from" invariant is now enforced by shared code, not by two copies staying
 * byte-identical.
 */
export const resolveFygaroTreasuryFundingWallet = async (): Promise<
  FygaroTreasuryFunding | FygaroCreditError
> => {
  const account = await AccountsRepository().findByRole(TREASURY_ROLE)
  if (account instanceof Error) {
    return new FygaroCreditError(
      "resolve-treasury",
      `no account holds the '${TREASURY_ROLE}' role`,
    )
  }

  const wallets = await WalletsRepository().listByAccountId(account.id)
  if (wallets instanceof Error) {
    return new FygaroCreditError(
      "list-treasury-wallets",
      "could not list treasury wallets",
    )
  }

  const fundingWallet =
    wallets.find((w) => w.currency === WalletCurrency.Usdt) ??
    wallets.find((w) => w.currency === WalletCurrency.Usd)
  if (!fundingWallet) {
    return new FygaroCreditError(
      "resolve-treasury-wallet",
      "treasury account has no USDT or USD wallet",
    )
  }

  return { account, fundingWallet }
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

  // Resolve the treasury funding wallet through the shared resolver so the
  // wallet credits drain from is provably the same one float-monitor watches.
  const funding = await resolveFygaroTreasuryFundingWallet()
  if (funding instanceof FygaroCreditError) {
    return funding
  }
  const { fundingWallet } = funding

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
    // Distinguish "the treasury is empty" (an ops top-up problem) from every
    // other send failure (a bug to debug) so payment.ts can raise the right
    // alert. The payment is still recorded and the row stays Fiat Received
    // either way — no double-spend risk.
    if (isInsufficientTreasuryBalance(result)) {
      return new FygaroCreditError(INSUFFICIENT_TREASURY_FLOAT_STEP, result.message)
    }
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
