import { USDAmount, WalletCurrency } from "@domain/shared"
import { LedgerTransactionType } from "@domain/ledger"

import { MainBook } from "./books"
import { persistAndReturnEntry } from "./helpers"

/**
 * Ledger service for recording topup transactions.
 *
 * This module handles the double-entry bookkeeping for topup payments,
 * ensuring proper accounting and reconciliation of funds flowing from
 * external payment providers (Fygaro, Stripe, PayPal) into user wallets.
 *
 * The topup flow is the reverse of cashout:
 * - Cashout: User Wallet → Bank Owner Wallet → External Bank
 * - Topup:   External Provider → Bank Owner Wallet → User Wallet
 */

/**
 * Arguments for recording a topup transaction in the ledger.
 *
 * @param recipientWalletId - The user's wallet that will receive the funds
 * @param bankOwnerWalletId - Flash's operational wallet (intermediary)
 * @param amount - The amount to credit (in USD cents or Satoshis)
 * @param currency - The wallet currency (USD or BTC)
 * @param provider - The payment provider source (fygaro, stripe, paypal)
 * @param externalTransactionId - Provider's unique transaction ID for idempotency
 * @param fee - Optional processing fee to deduct from the topup amount
 */
export type RecordTopupArgs = {
  recipientWalletId: WalletId
  bankOwnerWalletId: WalletId
  amount: UsdCents | Satoshis
  currency: WalletCurrency
  provider: "fygaro" | "stripe" | "paypal"
  externalTransactionId: string
  fee?: UsdCents | Satoshis
}

/**
 * Medici account structure for double-entry bookkeeping.
 *
 * These accounts represent different entities in our ledger:
 * - External: Payment provider accounts (money coming in)
 * - Revenue: Fee collection accounts
 * - Ibex: User and bank owner wallets managed by Ibex
 */
const Accounts = {
  External: (provider: string) => ["External", provider], // External payment sources
  Revenue: {
    TopupFees: ["Revenue", "Topup Fees"], // Collected processing fees
  },
  Ibex: (walletId: WalletId) => [`Ibex`, walletId], // Internal wallet accounts
}

/**
 * Maps payment provider names to their corresponding ledger transaction types.
 * This helps with transaction categorization and reporting.
 *
 * @param provider - The payment provider name
 * @returns The corresponding LedgerTransactionType enum value
 */
const getTransactionType = (provider: string): LedgerTransactionType => {
  switch (provider) {
    case "fygaro":
      return LedgerTransactionType.TopupFygaro
    case "stripe":
      return LedgerTransactionType.TopupStripe
    case "paypal":
      return LedgerTransactionType.TopupPaypal
    default:
      return LedgerTransactionType.TopupFygaro // Fallback to Fygaro type
  }
}

/**
 * Records a topup transaction in the ledger using double-entry bookkeeping.
 *
 * This function creates the necessary journal entries to track money flow:
 * 1. Debit from external provider (money comes in)
 * 2. Credit to user's wallet (user receives funds)
 * 3. Credit to revenue if there's a processing fee
 * 4. Internal transfer entries for bank owner wallet (balancing)
 *
 * The entries ensure complete audit trail and reconciliation capability.
 *
 * @returns The persisted ledger entry or an Error
 */
export const recordTopup = async ({
  recipientWalletId,
  bankOwnerWalletId,
  amount,
  currency,
  provider,
  externalTransactionId,
  fee,
}: RecordTopupArgs) => {
  const transactionType = getTransactionType(provider)

  // Convert amounts to numbers for Medici (handles both number and BigInt types)
  const topupAmount = typeof amount === "number" ? amount : Number(amount)
  const feeAmount = fee ? (typeof fee === "number" ? fee : Number(fee)) : 0
  const netAmount = topupAmount - feeAmount // Amount user actually receives after fees

  // Metadata attached to all journal entries for tracking and querying
  const metadata = {
    type: transactionType,              // Transaction category for reporting
    currency,                           // Currency of the transaction
    externalTransactionId,             // Provider's ID for idempotency checks
    pending: false,                    // Mark as completed (not pending)
  }

  /**
   * Create the journal entry for topup (reverse of cashout flow):
   *
   * CASHOUT FLOW (for reference):
   *   User Wallet (debit) → Bank Owner (credit) → External Bank (credit)
   *
   * TOPUP FLOW (this implementation):
   *   External Provider (debit) → Bank Owner (internal) → User Wallet (credit)
   *
   * The bank owner wallet acts as an intermediary, maintaining proper
   * separation between external providers and user wallets.
   */

  // Start building the journal entry with a descriptive memo
  let entry = MainBook.entry(`Topup from ${provider} to wallet ${recipientWalletId}`)
    // DEBIT: External provider account (money flowing IN from provider)
    .debit(Accounts.External(provider), topupAmount, {
      ...metadata,
      provider, // Track which provider sent the funds
    })
    // CREDIT: User's wallet receives the net amount (after fees)
    .credit(Accounts.Ibex(recipientWalletId), netAmount, {
      ...metadata,
      walletId: recipientWalletId, // Link to specific wallet
    })

  // If there's a processing fee, record it as revenue
  // This tracks how much Flash collects in topup fees
  if (feeAmount > 0) {
    entry = entry.credit(Accounts.Revenue.TopupFees, feeAmount, {
      type: transactionType,
      currency,
      externalTransactionId,
      pending: false,
    })
  }

  /**
   * Add bank owner wallet entries to complete the double-entry bookkeeping.
   *
   * These entries represent the internal transfer through Flash's operational wallet.
   * The debit and credit to the same account cancel out, but provide:
   * - Complete audit trail of fund movement
   * - Reconciliation point for operational wallet
   * - Clear separation between external and internal transactions
   *
   * The 'internal: true' flag marks these as internal transfers.
   */
  entry = entry
    .debit(Accounts.Ibex(bankOwnerWalletId), netAmount, {
      ...metadata,
      walletId: bankOwnerWalletId,
      internal: true, // Mark as internal transfer
    })
    .credit(Accounts.Ibex(bankOwnerWalletId), netAmount, {
      ...metadata,
      walletId: bankOwnerWalletId,
      internal: true, // Mark as internal transfer
    })

  // Persist the journal entry to the database
  return persistAndReturnEntry({ entry })
}

/**
 * Checks if a topup transaction already exists for the given external ID.
 *
 * This is the core idempotency protection mechanism. Payment providers
 * may send duplicate webhooks (network issues, retries, etc.), and we
 * must ensure each payment is only processed once.
 *
 * By checking the external transaction ID, we can detect and safely
 * ignore duplicate webhook calls without double-crediting users.
 *
 * @param externalTransactionId - The provider's unique transaction ID
 * @param provider - The payment provider name
 * @returns Existing ledger entries if found, or empty array if new transaction
 */
export const getTopupTransactionByExternalId = async (
  externalTransactionId: string,
  provider: string,
) => {
  // Map provider to transaction type for accurate querying
  const transactionType = getTransactionType(provider)

  // Query the ledger for any existing entries with this external ID
  // The combination of transaction type + external ID ensures uniqueness
  const { results: existingEntry } = await MainBook.ledger({
    "meta.type": transactionType,
    "meta.externalTransactionId": externalTransactionId,
  })

  return existingEntry
}
