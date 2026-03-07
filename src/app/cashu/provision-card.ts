import {
  createBlindedMessage,
  unblindSignature,
  splitIntoDenominations,
  CashuMintError,
  CashuInvalidCardPubkeyError,
  CashuBlindingError,
  CashuMintQuoteNotPaidError,
  CashuMintQuoteExpiredError,
} from "@domain/cashu"

import * as secp from "tiny-secp256k1"

import {
  requestMintQuote,
  getMintQuoteState,
  getMintKeysets,
  getMintKeyset,
  mintProofs,
} from "@services/cashu"

import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import { AccountValidator } from "@domain/accounts"
import { checkedToWalletId } from "@domain/wallets"
import { baseLogger } from "@services/logger"
import { payInvoiceByWalletId } from "@app/payments"

const logger = baseLogger.child({ module: "cashu-provision-card" })

const CASHU_UNIT = "usd"

/**
 * ENG-174: Cashu card provisioning
 *
 * Flow:
 *  1. Validate wallet belongs to account and has sufficient balance
 *  2. Fetch active USD keyset from mint
 *  3. Request mint quote (get Lightning invoice)
 *  4. Pay invoice from user's USD wallet
 *  5. Build P2PK-locked blind messages for requested denominations
 *  6. Submit to mint → receive blind signatures
 *  7. Unblind signatures → proofs
 *  8. Return proofs to caller (POS writes to card via NFC)
 */
export const provisionCashuCard = async ({
  walletId: uncheckedWalletId,
  accountId,
  amountCents,
  cardPubkey,
}: {
  walletId: string
  accountId: string
  amountCents: number
  cardPubkey: string
}): Promise<CashuCardProvisionResult | ApplicationError> => {
  // --- 1. Validate inputs ---
  const walletId = checkedToWalletId(uncheckedWalletId)
  if (walletId instanceof Error) return walletId

  if (amountCents <= 0 || !Number.isInteger(amountCents)) {
    return new CashuMintError("amountCents must be a positive integer")
  }

  // Validate card pubkey: must be 33-byte compressed secp256k1 point
  let cardPubkeyBytes: Uint8Array
  try {
    cardPubkeyBytes = Buffer.from(cardPubkey, "hex")
    if (cardPubkeyBytes.length !== 33 || !secp.isPoint(cardPubkeyBytes)) {
      return new CashuInvalidCardPubkeyError(
        "cardPubkey must be a 33-byte compressed secp256k1 point (66 hex chars)",
      )
    }
  } catch {
    return new CashuInvalidCardPubkeyError("cardPubkey is not valid hex")
  }

  // --- 2. Validate account + wallet ---
  const account = await AccountsRepository().findById(accountId as AccountId)
  if (account instanceof Error) return account

  const accountValidator = AccountValidator(account).isActive()
  if (accountValidator instanceof Error) return accountValidator

  const wallet = await WalletsRepository().findById(walletId)
  if (wallet instanceof Error) return wallet

  if (wallet.accountId !== accountId) {
    return new CashuMintError("Wallet does not belong to the current account")
  }

  if (wallet.currency !== "USD") {
    return new CashuMintError("Card provisioning requires a USD wallet")
  }

  // --- 3. Fetch active USD keyset from mint ---
  const keysets = await getMintKeysets()
  if (keysets instanceof Error) return keysets

  const usdKeyset = keysets.find((ks) => ks.unit === CASHU_UNIT && ks.active)
  if (!usdKeyset) {
    return new CashuMintError("No active USD keyset found on mint")
  }

  const keysetDetail = await getMintKeyset(usdKeyset.id)
  if (keysetDetail instanceof Error) return keysetDetail

  // keys is { "1": pubkey_hex, "2": pubkey_hex, ... }
  const mintKeys: Record<string, string> = keysetDetail.keys

  // --- 4. Request mint quote ---
  const quote = await requestMintQuote(amountCents)
  if (quote instanceof Error) return quote

  logger.info({ quoteId: quote.quoteId, amountCents }, "cashu: mint quote received")

  // --- 5. Pay the mint invoice from user's wallet ---
  const payResult = await payInvoiceByWalletId({
    uncheckedPaymentRequest: quote.paymentRequest,
    memo: `Cashu card provisioning — ${amountCents} cents`,
    senderWalletId: walletId as WalletId,
    senderAccount: account,
  })
  if (payResult instanceof Error) return payResult

  logger.info({ quoteId: quote.quoteId }, "cashu: mint invoice paid")

  // Confirm mint sees payment
  const quotePaid = await getMintQuoteState(quote.quoteId)
  if (quotePaid instanceof Error) return quotePaid
  if (quotePaid.state === "EXPIRED") return new CashuMintQuoteExpiredError()
  if (quotePaid.state !== "PAID") {
    return new CashuMintQuoteNotPaidError(
      `Mint quote state is ${quotePaid.state} — expected PAID`,
    )
  }

  // --- 6. Build P2PK blind messages ---
  const denominations = splitIntoDenominations(amountCents)

  const blindingDataList: (CashuBlindingData & { keysetId: string })[] = []
  const blindedMessages: CashuBlindedMessage[] = []

  for (const amount of denominations) {
    if (!mintKeys[String(amount)]) {
      return new CashuMintError(
        `Mint keyset has no key for denomination ${amount} cents`,
      )
    }
    try {
      const bd = createBlindedMessage(usdKeyset.id, amount, cardPubkey)
      blindingDataList.push({ ...bd, keysetId: usdKeyset.id })
      blindedMessages.push({ id: usdKeyset.id, amount, B_: bd.B_ })
    } catch (err) {
      logger.error({ err, amount }, "cashu: blinding failed")
      return new CashuBlindingError(`Blinding failed for amount ${amount}: ${(err as Error).message}`)
    }
  }

  // --- 7. Submit to mint, receive blind signatures ---
  const blindSigs = await mintProofs(quote.quoteId, blindedMessages)
  if (blindSigs instanceof Error) return blindSigs

  // --- 8. Unblind signatures → final proofs ---
  const proofs: CashuProof[] = []

  for (let i = 0; i < blindSigs.length; i++) {
    const sig = blindSigs[i]
    const bd = blindingDataList[i]
    const mintPubkey = mintKeys[String(sig.amount)]

    if (!mintPubkey) {
      return new CashuBlindingError(`No mint pubkey for amount ${sig.amount}`)
    }

    let C: string
    try {
      C = unblindSignature(sig.C_, bd.r, mintPubkey)
    } catch (err) {
      logger.error({ err, amount: sig.amount }, "cashu: unblinding failed")
      return new CashuBlindingError(`Unblinding failed: ${(err as Error).message}`)
    }

    proofs.push({
      id: sig.id,
      amount: sig.amount,
      secret: bd.secretStr, // full NUT-10 P2PK JSON string
      C,
    })
  }

  logger.info(
    { cardPubkey: cardPubkey.slice(0, 10) + "…", proofCount: proofs.length, amountCents },
    "cashu: card provisioned successfully",
  )

  return {
    proofs,
    cardPubkey,
    totalAmount: amountCents,
  }
}
