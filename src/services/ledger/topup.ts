import { USDAmount, WalletCurrency } from "@domain/shared"
import { LedgerTransactionType } from "@domain/ledger"

import { MainBook } from "./books"
import { persistAndReturnEntry } from "./helpers"

export type RecordTopupArgs = {
  recipientWalletId: WalletId
  bankOwnerWalletId: WalletId
  amount: UsdCents | Satoshis
  currency: WalletCurrency
  provider: "fygaro" | "stripe" | "paypal"
  externalTransactionId: string
  fee?: UsdCents | Satoshis
}

// Medici accounts
const Accounts = {
  External: (provider: string) => ["External", provider],
  Revenue: {
    TopupFees: ["Revenue", "Topup Fees"],
  },
  Ibex: (walletId: WalletId) => [`Ibex`, walletId],
}

const getTransactionType = (provider: string): LedgerTransactionType => {
  switch (provider) {
    case "fygaro":
      return LedgerTransactionType.TopupFygaro
    case "stripe":
      return LedgerTransactionType.TopupStripe
    case "paypal":
      return LedgerTransactionType.TopupPaypal
    default:
      return LedgerTransactionType.TopupFygaro
  }
}

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

  // Convert amounts to numbers for Medici
  const topupAmount = typeof amount === "number" ? amount : Number(amount)
  const feeAmount = fee ? (typeof fee === "number" ? fee : Number(fee)) : 0
  const netAmount = topupAmount - feeAmount

  const metadata = {
    type: transactionType,
    currency,
    externalTransactionId,
    pending: false,
  }

  // Create the journal entry
  // For topup, we're essentially doing the reverse of cashout:
  // 1. External provider account is debited (money comes in from external source)
  // 2. Bank owner wallet is debited (Flash's operational wallet sends to user)
  // 3. User wallet is credited (user receives funds)
  // 4. If there's a fee, revenue account is credited

  let entry = MainBook.entry(`Topup from ${provider} to wallet ${recipientWalletId}`)
    .debit(Accounts.External(provider), topupAmount, {
      ...metadata,
      provider,
    })
    .credit(Accounts.Ibex(recipientWalletId), netAmount, {
      ...metadata,
      walletId: recipientWalletId,
    })

  // If there's a fee, credit it to revenue
  if (feeAmount > 0) {
    entry = entry.credit(Accounts.Revenue.TopupFees, feeAmount, {
      type: transactionType,
      currency,
      externalTransactionId,
      pending: false,
    })
  }

  // Add bank owner wallet debit/credit to balance the transaction
  // This represents the internal transfer from Flash's operational wallet to user
  entry = entry
    .debit(Accounts.Ibex(bankOwnerWalletId), netAmount, {
      ...metadata,
      walletId: bankOwnerWalletId,
      internal: true,
    })
    .credit(Accounts.Ibex(bankOwnerWalletId), netAmount, {
      ...metadata,
      walletId: bankOwnerWalletId,
      internal: true,
    })

  return persistAndReturnEntry({ entry })
}

export const getTopupTransactionByExternalId = async (
  externalTransactionId: string,
  provider: string,
) => {
  // Check if a topup transaction already exists with this external ID
  // This is for idempotency checking
  const transactionType = getTransactionType(provider)

  const { results: existingEntry } = await MainBook.ledger({
    "meta.type": transactionType,
    "meta.externalTransactionId": externalTransactionId,
  })

  return existingEntry
}
