import { GiftCardsConfig, getSendGuardMode } from "@config"

import {
  authorizeSend,
  gateSend,
  SendRejectionReasons,
} from "@app/payments/authorize-send"
import { payLnInvoiceViaIbex } from "@app/payments/pay-invoice-via-ibex"
import { toSats } from "@domain/bitcoin"
import { decodeInvoice, PaymentSendStatus } from "@domain/bitcoin/lightning"
import { IdempotencyKeyReuseError, InvalidIdempotencyKeyError } from "@domain/errors"
import {
  checkedGiftCardQuantity,
  checkedGiftCardValue,
  GIFT_CARD_QUOTE_TOLERANCE_BPS,
  GiftCardIdempotencyKeyReuseError,
  GiftCardOrderNotFoundError,
  GiftCardOrderStateError,
  GiftCardOrderStatus,
  GiftCardProductNotAvailableInCountryError,
  GiftCardProductNotFoundError,
  GiftCardQuoteMismatchError,
  GiftCardVendorRejectedOrderError,
  GiftCardVendorUnavailableError,
  normalizeCountryCode,
  parseGiftCardProductId,
  UnknownGiftCardError,
} from "@domain/gift-cards"
import { LockServiceError } from "@domain/lock"
import { LnPaymentRequestNonZeroAmountRequiredError } from "@domain/payments"
import { RateLimitConfig } from "@domain/rate-limit"
import { GiftCardPurchaseRateLimiterExceededError } from "@domain/rate-limit/errors"
import { ErrorLevel, ValidationError } from "@domain/shared"
import { claimCryptoReady } from "@services/gift-cards/claim-crypto"
import { getEnabledGiftCardProvider } from "@services/gift-cards/registry"
import { FailedIbexPayment, InsufficientIbexBalance } from "@services/ibex/errors"
import { baseLogger } from "@services/logger"
import {
  AccountsRepository,
  GiftCardOrdersRepository,
  WalletsRepository,
} from "@services/mongoose"
import { consumeLimiter } from "@services/rate-limit"
import {
  addAttributesToCurrentSpan,
  recordExceptionInCurrentSpan,
} from "@services/tracing"

import {
  authorizeGiftCardPurchase,
  releaseGiftCardReservation,
} from "./authorize-purchase"
import {
  giftCardsMasterGate,
  resolveAccountCountryCodeOrUnknown,
} from "./gift-cards-master-gate"
import { getGiftCardProduct } from "./list-products"
import { notifyGiftCardOpsEvent } from "./ops"
import { fetchAndSettle } from "./settle-order"

/**
 * ENG-580 — purchase orchestration.
 *
 *   gate → product → validate → quote → authorize → CREATED → vendor order →
 *   tolerance → INVOICE_ISSUED → pay → PAID | PAYMENT_PENDING | PAYMENT_FAILED
 *   → one fulfilment poll → return
 *
 * Returns the order (possibly already FULFILLED) or an ApplicationError; never
 * throws. Money moves exactly once per order: the Lightning send is wrapped in
 * `withPaymentIdempotency` under `giftcard:<orderId>`, and the order row itself
 * is unique on (walletId, idempotencyKey), so a replayed mutation finds the
 * existing order before it ever reaches the vendor.
 *
 * PAYMENT_FAILED is reserved for outcomes that PROVE IBEX never accepted the
 * send (see `isDefinitiveSendRejection`). The client reads that state as
 * "nothing left the wallet, buy again with a new key", so an error that merely
 * says "we don't know" — a socket reset or gateway 5xx after IBEX took the
 * request, an unreadable 200 — must never land there. Those go to
 * PAYMENT_PENDING and the reconcile worker settles them against IBEX and,
 * failing that, the vendor. A busy idempotency lock writes NOTHING: a
 * concurrent same-key attempt owns the outcome and will record it.
 *
 * Once IBEX has answered Success or Pending this function never returns a bare
 * error. If the row cannot record the outcome (a concurrent attempt moved it,
 * the worker expired it, Mongo failed) the caller still gets an order — the
 * row as it now stands when that is consistent with the money having moved,
 * otherwise the in-memory order with a Critical `paid-not-recorded` page.
 * Returning an error there would invite the client to buy again.
 *
 * Claim data never passes through this module: fulfilment is `settle-order`'s
 * job and it stores ciphertext only. The claim KEY is checked before paying,
 * though: a card we could not store the code for is a customer who paid for
 * something they cannot see.
 */
export type PurchaseGiftCardArgs = {
  accountId: AccountId
  walletId: WalletId
  productId: string
  valueMinor: number
  quantity: number
  idempotencyKey: string
}

// How long a CREATED / INVOICE_ISSUED order stays payable before the reconcile
// worker expires it. The vendor's BOLT11 is usually shorter; we take the earlier.
const ORDER_TTL_MS = 15 * 60 * 1000

const MAX_IDEMPOTENCY_KEY_LENGTH = 256

const snapshotOf = (product: GiftCardProduct): GiftCardProductSnapshot => ({
  name: product.name,
  brand: product.brand,
  countryCode: product.countryCode,
  currency: product.currency,
  isOpenLoop: product.isOpenLoop,
  logoUrl: product.logoUrl,
})

const sameParameters = (
  order: GiftCardOrder,
  args: { providerProductId: string; valueMinor: number; quantity: number },
): boolean =>
  order.providerProductId === args.providerProductId &&
  order.valueMinor === args.valueMinor &&
  order.quantity === args.quantity

const isValidDate = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime())

/** The earliest of `first` and every valid Date among `rest`. */
const earliestDate = (
  first: Date,
  ...rest: ReadonlyArray<Date | null | undefined>
): Date => rest.reduce<Date>((min, d) => (isValidDate(d) && d < min ? d : min), first)

/**
 * The ENG-573 send guard, built exactly as `lnInvoicePaymentSend` builds it:
 * decode is part of the guard (so log-only never blocks on it), a zero-amount
 * invoice is a gated rejection, and the decoded sats are what the cap is
 * judged on. Runs inside the idempotency lock, only on the path that pays.
 *
 * `onReject` fires when the guard refuses. The wrapper runs the guard
 * immediately before `execute`, so a refusal here is proof that IBEX was never
 * called — which is what lets the caller file it under PAYMENT_FAILED.
 */
const buildSendGuardHook =
  ({
    senderAccount,
    senderWalletId,
    paymentRequest,
    onReject,
  }: {
    senderAccount: Account
    senderWalletId: WalletId
    paymentRequest: string
    onReject: () => void
  }): SendGuardHook =>
  async () => {
    const verdict = await judgeSend({ senderAccount, senderWalletId, paymentRequest })
    if (verdict instanceof Error) onReject()
    return verdict
  }

const judgeSend = async ({
  senderAccount,
  senderWalletId,
  paymentRequest,
}: {
  senderAccount: Account
  senderWalletId: WalletId
  paymentRequest: string
}): Promise<true | ApplicationError> => {
  if (getSendGuardMode() === "off") return true

  const gate = (error: ApplicationError) =>
    gateSend({
      error,
      reason: SendRejectionReasons.undecodableInvoice,
      senderAccount,
      senderWalletId,
      kind: "lightning",
    })

  const decoded = decodeInvoice(paymentRequest)
  if (decoded instanceof Error) return gate(decoded)
  if (decoded.paymentAmount === null) {
    return gate(new LnPaymentRequestNonZeroAmountRequiredError())
  }

  return authorizeSend({
    senderAccount,
    senderWalletId,
    amount: { currency: "BTC", sats: decoded.paymentAmount.amount },
    kind: "lightning",
  })
}

/**
 * Does this error prove IBEX never accepted the send? Only then is
 * PAYMENT_FAILED honest.
 *
 *  - send guard refused: runs inside the idempotency lock immediately before
 *    `execute`, so `execute` (and the IBEX call) never ran
 *  - InvalidIdempotencyKeyError / IdempotencyKeyReuseError: the wrapper
 *    refused before `execute`, or replayed a cached result for a different
 *    fingerprint without executing
 *  - InsufficientIbexBalance: IBEX's 400 for "no funds"; nothing was sent
 *  - FailedIbexPayment: IBEX's 200 carrying a corroborated FAILED
 *
 * Everything else — the generic IbexError for a network fault, timeout, 5xx or
 * auth failure; UnconfirmedIbexPayment; CompletedInvoice ("already prepared",
 * which may be OUR earlier attempt); the busy LockServiceError while a
 * concurrent same-key attempt is mid-flight — says nothing about whether money
 * moved. That is the KNOWN GAP `withPaymentIdempotency` documents: IBEX may
 * have debited and then errored to us.
 */
const isDefinitiveSendRejection = (
  error: ApplicationError,
  guardRejected: boolean,
): boolean =>
  guardRejected ||
  error instanceof InvalidIdempotencyKeyError ||
  error instanceof IdempotencyKeyReuseError ||
  error instanceof InsufficientIbexBalance ||
  error instanceof FailedIbexPayment

/** Move an unpaid order to FAILED and report it. Transition errors are logged, not surfaced. */
const failUnpaidOrder = async (
  order: GiftCardOrder,
  reason: string,
  error: ApplicationError,
): Promise<void> => {
  const failed = await GiftCardOrdersRepository().transition({
    id: order.id,
    from: [GiftCardOrderStatus.Created, GiftCardOrderStatus.InvoiceIssued],
    to: GiftCardOrderStatus.Failed,
    reason,
    patch: { failureReason: reason },
  })
  if (failed instanceof Error) {
    baseLogger.error(
      { orderId: order.id, reason, error: failed.constructor.name },
      "Could not mark gift card order FAILED",
    )
  }
  notifyGiftCardOpsEvent({
    phase: "order-failed",
    status: "failed",
    order,
    error: error.constructor.name,
    meta: { reason },
  })
}

export const purchaseGiftCard = async (
  args: PurchaseGiftCardArgs,
): Promise<GiftCardOrder | ApplicationError> => {
  const { accountId, walletId, productId } = args
  addAttributesToCurrentSpan({
    "giftcard.productId": productId,
    "giftcard.valueMinor": args.valueMinor,
    "giftcard.quantity": args.quantity,
  })

  const idempotencyKey = (args.idempotencyKey ?? "").trim()
  if (idempotencyKey.length === 0 || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return new InvalidIdempotencyKeyError(args.idempotencyKey)
  }

  const account = await AccountsRepository().findById(accountId)
  if (account instanceof Error) return account

  const wallet = await WalletsRepository().findById(walletId)
  if (wallet instanceof Error) return wallet
  // Object-level authz: never trust a client-supplied walletId on its own.
  if (wallet.accountId !== account.id) {
    return new ValidationError("Wallet does not belong to account")
  }

  const repo = GiftCardOrdersRepository()

  // Replay: the row is unique on (walletId, idempotencyKey). Same key, same
  // parameters → the existing order (see `replayExistingOrder` for the one
  // state that is resumed rather than returned). Same key, different
  // parameters → refused, never silently swapped for the old order.
  const parsed = parseGiftCardProductId(productId)
  if (parsed instanceof Error) return parsed

  const existing = await repo.findByIdempotencyKey({ walletId, idempotencyKey })
  if (!(existing instanceof GiftCardOrderNotFoundError)) {
    if (existing instanceof Error) return existing
    if (
      existing.providerId !== parsed.providerId ||
      !sameParameters(existing, {
        providerProductId: parsed.providerProductId,
        valueMinor: args.valueMinor,
        quantity: args.quantity,
      })
    ) {
      return new GiftCardIdempotencyKeyReuseError()
    }
    addAttributesToCurrentSpan({
      "giftcard.orderId": existing.id,
      "giftcard.replay": true,
    })
    return replayExistingOrder({ existing, account, walletId })
  }

  // Attempt budget, charged before any vendor round-trip so a client looping
  // on a refused request bounds its own cost — but AFTER the replay lookup, so
  // polling an order you already own by re-sending its key costs nothing. A
  // limiter STORE fault falls through (same posture as fygaroCheckoutCreate):
  // refusing every first attempt during a Redis blip would page nobody and
  // block everyone.
  const limitOk = await consumeLimiter({
    rateLimitConfig: RateLimitConfig.giftCardPurchase,
    keyToConsume: accountId,
  })
  if (limitOk instanceof GiftCardPurchaseRateLimiterExceededError) return limitOk
  if (limitOk instanceof Error) {
    baseLogger.warn(
      { accountId, error: limitOk.constructor.name },
      "Gift card purchase rate limiter unavailable; continuing",
    )
  }

  // Master gate with the account's routing country.
  const countryCode = await resolveAccountCountryCodeOrUnknown(account)
  const gate = giftCardsMasterGate(countryCode)
  if (!gate.ok) return gate.error
  addAttributesToCurrentSpan({ "giftcard.provider": gate.providerId })

  const product = await getGiftCardProduct(productId as GiftCardProductId)
  if (product instanceof Error) return product
  // The product must come from the provider routed for this account. A
  // Bitrefill id in a Bitcoin-Company country is "not available here".
  if (product.providerId !== gate.providerId) {
    return new GiftCardProductNotAvailableInCountryError()
  }
  // ...and from this country's catalog. The storefront lists by country, so a
  // mismatch is a client that browsed one country and bought from another.
  // Skipped when the account's country is unknown: the routed provider's
  // catalog is all we have to go on then.
  if (
    gate.countryKnown &&
    normalizeCountryCode(product.countryCode) !== gate.countryCode
  ) {
    return new GiftCardProductNotAvailableInCountryError()
  }
  if (!product.inStock) {
    return new GiftCardProductNotFoundError("This gift card is currently out of stock")
  }

  const valueMinor = checkedGiftCardValue(product, args.valueMinor)
  if (valueMinor instanceof Error) return valueMinor
  const quantity = checkedGiftCardQuantity(args.quantity, product.maxQuantity)
  if (quantity instanceof Error) return quantity

  const provider = getEnabledGiftCardProvider(gate.providerId)
  if (provider instanceof Error) return provider

  const quote = await provider.quote({ product, valueMinor, quantity })
  if (quote instanceof Error) return quote

  const authorization = await authorizeGiftCardPurchase({
    account,
    product,
    valueMinor,
    quantity,
  })
  if (!authorization.authorized) return authorization.error

  const created = await repo.create({
    accountId,
    walletId,
    walletCurrency: wallet.currency,
    providerId: product.providerId,
    providerProductId: product.providerProductId,
    productSnapshot: snapshotOf(product),
    valueMinor,
    currency: product.currency,
    quantity,
    quoteSats: quote.satsCost,
    idempotencyKey,
    expiresAt: new Date(Date.now() + ORDER_TTL_MS),
  })
  // The row now carries the amount for the daily-cap sum (see
  // reservation-store.ts); the hold has done its job either way.
  await releaseGiftCardReservation(accountId, authorization.reservationId)
  if (created instanceof Error) {
    // A concurrent same-key request may have won the unique index. Replay it.
    const raced = await repo.findByIdempotencyKey({ walletId, idempotencyKey })
    if (!(raced instanceof Error)) {
      return sameParameters(raced, {
        providerProductId: product.providerProductId,
        valueMinor,
        quantity,
      })
        ? raced
        : new GiftCardIdempotencyKeyReuseError()
    }
    // No winner to hand back: the create failed for a reason that was not the
    // index, or the re-read failed too. Either way a repository fault, and
    // surfaced as one — never as the repository-private duplicate-key error,
    // which the GraphQL error map does not know and would turn into a 500.
    recordExceptionInCurrentSpan({ error: created })
    baseLogger.error(
      {
        accountId,
        walletId,
        error: created.constructor.name,
        reread: raced.constructor.name,
      },
      "Could not create gift card order",
    )
    return new UnknownGiftCardError("Could not create gift card order")
  }
  addAttributesToCurrentSpan({ "giftcard.orderId": created.id })
  notifyGiftCardOpsEvent({ phase: "order-created", status: "pending", order: created })

  const vendorOrder = await provider.createOrder({
    product,
    valueMinor,
    quantity,
    reference: created.id,
  })
  if (vendorOrder instanceof Error) {
    const error =
      vendorOrder instanceof GiftCardVendorUnavailableError ||
      vendorOrder instanceof GiftCardVendorRejectedOrderError
        ? vendorOrder
        : new GiftCardVendorRejectedOrderError(vendorOrder.message)
    await failUnpaidOrder(
      created,
      `vendor-create-failed: ${vendorOrder.constructor.name}`,
      error,
    )
    return error
  }

  // The invoice we are about to pay is the source of truth for what it costs;
  // the vendor's stated amount is cross-checked against it. Either one
  // drifting past tolerance from the quote the customer saw refuses the pay.
  const decoded = decodeInvoice(vendorOrder.paymentRequest)
  if (decoded instanceof Error || decoded.paymentAmount === null) {
    const error = new GiftCardVendorRejectedOrderError(
      "Gift card provider returned an unreadable invoice",
    )
    await failUnpaidOrder(created, "vendor-invoice-undecodable", error)
    return error
  }
  const invoiceSats = toSats(decoded.paymentAmount.amount)
  const chargedSats = Math.max(invoiceSats, Number(vendorOrder.amountSats))
  const toleranceBps = GiftCardsConfig.quoteToleranceBps ?? GIFT_CARD_QUOTE_TOLERANCE_BPS
  const maxSats = Math.floor(Number(quote.satsCost) * (1 + toleranceBps / 10_000))
  addAttributesToCurrentSpan({
    "giftcard.quoteSats": Number(quote.satsCost),
    "giftcard.invoiceSats": invoiceSats,
  })
  if (chargedSats > maxSats) {
    const error = new GiftCardQuoteMismatchError(
      "The gift card price changed; please try again",
    )
    await failUnpaidOrder(
      created,
      `quote-mismatch: quoted ${quote.satsCost} invoiced ${chargedSats}`,
      error,
    )
    return error
  }

  // The order is payable only as long as the invoice is. The BOLT11's own
  // expiry is the source of truth; the order TTL caps it; a vendor that states
  // an explicit order expiry (TBC does not) can only bring it forward.
  const issued = await repo.transition({
    id: created.id,
    from: [GiftCardOrderStatus.Created],
    to: GiftCardOrderStatus.InvoiceIssued,
    reason: "vendor-invoice-issued",
    patch: {
      providerOrderId: vendorOrder.providerOrderId,
      paymentRequest: vendorOrder.paymentRequest,
      invoiceSats,
      paymentHash: decoded.paymentHash,
      expiresAt: earliestDate(
        created.expiresAt,
        decoded.expiresAt,
        vendorOrder.expiresAt,
      ),
    },
  })
  if (issued instanceof Error) {
    // Nothing paid. The row stays CREATED and the reconcile worker expires it.
    recordExceptionInCurrentSpan({ error: issued })
    return issued
  }

  return payIssuedOrder({
    account,
    walletId,
    order: issued,
    paymentRequest: vendorOrder.paymentRequest,
    invoiceSats,
  })
}

/**
 * Same key, same parameters. Every state is handed back as it is, with one
 * exception: a still-payable INVOICE_ISSUED row. That is a first attempt that
 * died between issuing the invoice and recording the payment's outcome, and
 * handing it back as "keep polling" could only ever end in EXPIRED — writing
 * the money off if IBEX had in fact paid. Re-entering the pay step is safe by
 * construction: `withPaymentIdempotency` under `giftcard:<orderId>` replays a
 * cached outcome, refuses to run alongside an in-flight attempt, or makes the
 * one send that never happened.
 *
 * CREATED is left alone (the vendor's createOrder is not idempotent; the worker
 * expires it), as is an INVOICE_ISSUED row past its expiry (the worker asks the
 * vendor before expiring it, and a send that settles after expiry revives the
 * row from the pay step: EXPIRED → PAID). The kill switch stops the resume too
 * — it is new money leaving — and the worker's vendor poll still settles an
 * invoice the first attempt did pay.
 */
const replayExistingOrder = async ({
  existing,
  account,
  walletId,
}: {
  existing: GiftCardOrder
  account: Account
  walletId: WalletId
}): Promise<GiftCardOrder | ApplicationError> => {
  if (existing.status !== GiftCardOrderStatus.InvoiceIssued) return existing
  if (existing.expiresAt.getTime() <= Date.now()) return existing
  if (!existing.paymentRequest) return existing
  if (GiftCardsConfig.enabled !== true) return existing

  addAttributesToCurrentSpan({ "giftcard.replay.resumedPayment": true })
  baseLogger.info(
    { orderId: existing.id },
    "Gift card purchase replayed on an unpaid INVOICE_ISSUED order; resuming the payment",
  )
  return payIssuedOrder({
    account,
    walletId,
    order: existing,
    paymentRequest: existing.paymentRequest,
    invoiceSats: existing.invoiceSats ?? existing.quoteSats,
  })
}

/**
 * The pay step and the transitions that follow it, for an INVOICE_ISSUED
 * order. Entered by the purchase flow once and by a same-key replay of an
 * unpaid order; both are idempotent under `giftcard:<orderId>`.
 *
 * IBEX-custodial rail (see @app/payments/pay-invoice-via-ibex): the same
 * idempotency wrapper and send guard as lnInvoicePaymentSend. The fingerprint
 * binds the cached result to THIS order as well as the invoice, so a different
 * order can never replay a previous success.
 *
 * The IBEX transaction id is the only handle the reconcile worker has to
 * re-query an in-flight send; it is captured from the raw 200 and written with
 * whichever transition follows. A crash between the IBEX call and that
 * transition leaves INVOICE_ISSUED with no ref — a same-key replay resumes it,
 * and the worker polls the vendor before expiring it.
 */
const payIssuedOrder = async ({
  account,
  walletId,
  order,
  paymentRequest,
  invoiceSats,
}: {
  account: Account
  walletId: WalletId
  order: GiftCardOrder
  paymentRequest: string
  invoiceSats: Satoshis
}): Promise<GiftCardOrder | ApplicationError> => {
  // Last free refusal. The vendor will hand back a claim code the moment this
  // invoice is paid; if the key that seals it is missing or malformed we could
  // take the money and then be unable to store what it bought. Checked on the
  // first attempt and on every replay-resume, both of which pass through here.
  const cryptoReady = claimCryptoReady()
  if (cryptoReady instanceof Error) {
    recordExceptionInCurrentSpan({ error: cryptoReady })
    await failUnpaidOrder(order, "claim-key-not-configured", cryptoReady)
    return cryptoReady
  }

  const captured: { providerPaymentRef: string | null; guardRejected: boolean } = {
    providerPaymentRef: null,
    guardRejected: false,
  }
  const payment = await payLnInvoiceViaIbex({
    senderWalletId: walletId,
    senderAccount: account,
    paymentRequest,
    idempotencyKey: `giftcard:${order.id}`,
    requestFingerprint: `ln|${paymentRequest}|giftcard|${order.id}`,
    authorize: buildSendGuardHook({
      senderAccount: account,
      senderWalletId: walletId,
      paymentRequest,
      onReject: () => {
        captured.guardRejected = true
      },
    }),
    onResponse: (response) => {
      const id = response?.transaction?.id
      if (typeof id === "string" && id.length > 0) captured.providerPaymentRef = id
    },
  })
  const { providerPaymentRef } = captured
  addAttributesToCurrentSpan({ "giftcard.providerPaymentRef": providerPaymentRef ?? "" })

  if (payment instanceof Error) {
    if (payment instanceof LockServiceError) {
      // A concurrent same-key attempt holds the payment lock. IBEX was not
      // asked by THIS call, and that attempt's outcome — with its transaction
      // id — is the order's. Writing anything here would race its transition
      // and could overwrite the ref it captured with null. Hand back the row
      // as it stands; the client polls.
      addAttributesToCurrentSpan({ "giftcard.replay.lockBusy": true })
      baseLogger.info(
        { orderId: order.id, error: payment.constructor.name },
        "Gift card payment lock busy; a concurrent attempt owns the outcome",
      )
      return GiftCardOrdersRepository().findById(order.id)
    }
    if (isDefinitiveSendRejection(payment, captured.guardRejected)) {
      await markPaymentFailed(
        order,
        `payment-error: ${payment.constructor.name}`,
        payment,
        providerPaymentRef,
      )
      return payment
    }
    return markPaymentUnconfirmed(order, payment, providerPaymentRef)
  }

  // Compare by value: a replayed status comes back from the idempotency cache
  // as a fresh object, not the `PaymentSendStatus` constant.
  switch (payment.value) {
    case PaymentSendStatus.Success.value:
    case PaymentSendStatus.AlreadyPaid.value:
      return markPaidAndSettle(order, invoiceSats, providerPaymentRef)
    case PaymentSendStatus.Pending.value:
      return markPaymentPending(order, { reason: "payment-pending", providerPaymentRef })
    default:
      return markPaymentFailed(order, "payment-failed", null, providerPaymentRef)
  }
}

/**
 * The `providerPaymentRef` half of a transition patch. Only written when IBEX
 * actually handed one back on this call: a replayed (cached) outcome never
 * invokes `onResponse`, and `$set: { providerPaymentRef: null }` from such a
 * replay would erase the ref the first attempt recorded.
 */
const refPatch = (providerPaymentRef: string | null): { providerPaymentRef?: string } =>
  providerPaymentRef ? { providerPaymentRef } : {}

/** The row already says the money moved (or may have). Nothing to add. */
const MONEY_MOVED_STATUSES: readonly GiftCardOrderStatus[] = [
  GiftCardOrderStatus.PaymentPending,
  GiftCardOrderStatus.Paid,
  GiftCardOrderStatus.Fulfilled,
]

/**
 * IBEX answered Success or Pending but the order row could not take the
 * transition that records it. The money has (or may have) left the wallet and
 * the row says otherwise: page, and hand the caller the order as this call last
 * knew it rather than an error — an error would read as "buy again".
 */
const paidNotRecorded = ({
  order,
  providerPaymentRef,
  intended,
  cause,
  rowStatus,
}: {
  order: GiftCardOrder
  providerPaymentRef: string | null
  intended: GiftCardOrderStatus
  cause: ApplicationError
  rowStatus?: GiftCardOrderStatus
}): GiftCardOrder => {
  recordExceptionInCurrentSpan({ error: cause, level: ErrorLevel.Critical })
  baseLogger.error(
    {
      orderId: order.id,
      providerPaymentRef,
      intended,
      rowStatus: rowStatus ?? "unreadable",
      error: cause.constructor.name,
    },
    "Gift card payment answered by IBEX but the order row could not record it",
  )
  notifyGiftCardOpsEvent({
    phase: "paid-not-recorded",
    status: "failed",
    order,
    error: cause.constructor.name,
    meta: {
      providerPaymentRef: providerPaymentRef ?? "none",
      intendedStatus: intended,
      rowStatus: rowStatus ?? "unreadable",
    },
  })
  return order
}

/**
 * The send errored without proving IBEX refused it: money may have left the
 * wallet. PAYMENT_PENDING is the only honest state — the reconcile worker
 * re-reads IBEX when it has a transaction id and asks the vendor when it does
 * not. Returns the pending order, not the error: the client must poll, never
 * retry with a fresh key.
 */
const markPaymentUnconfirmed = async (
  order: GiftCardOrder,
  error: ApplicationError,
  providerPaymentRef: string | null,
): Promise<GiftCardOrder> => {
  const reason = `payment-unconfirmed: ${error.constructor.name}`
  recordExceptionInCurrentSpan({ error })
  baseLogger.warn(
    { orderId: order.id, providerPaymentRef, error: error.constructor.name },
    "Gift card payment outcome unknown after send error; holding as PAYMENT_PENDING",
  )
  return markPaymentPending(order, { reason, providerPaymentRef, error })
}

const markPaymentPending = async (
  order: GiftCardOrder,
  {
    reason,
    providerPaymentRef,
    error,
  }: { reason: string; providerPaymentRef: string | null; error?: ApplicationError },
): Promise<GiftCardOrder> => {
  const repo = GiftCardOrdersRepository()
  const pending = await repo.transition({
    id: order.id,
    from: [GiftCardOrderStatus.InvoiceIssued],
    to: GiftCardOrderStatus.PaymentPending,
    reason,
    patch: refPatch(providerPaymentRef),
  })
  if (pending instanceof GiftCardOrderStateError) {
    // A concurrent same-key attempt already moved the order on — to its own
    // PAYMENT_PENDING, or to the PAID / FULFILLED its send resolved to.
    // Whatever it wrote is the truth. A row in any other state contradicts an
    // IBEX that says the send is in flight: page it.
    const latest = await repo.findById(order.id)
    if (latest instanceof Error) {
      return paidNotRecorded({
        order,
        providerPaymentRef,
        intended: GiftCardOrderStatus.PaymentPending,
        cause: latest,
      })
    }
    if (MONEY_MOVED_STATUSES.includes(latest.status)) return latest
    return paidNotRecorded({
      order,
      providerPaymentRef,
      intended: GiftCardOrderStatus.PaymentPending,
      cause: pending,
      rowStatus: latest.status,
    })
  }
  if (pending instanceof Error) {
    return paidNotRecorded({
      order,
      providerPaymentRef,
      intended: GiftCardOrderStatus.PaymentPending,
      cause: pending,
    })
  }
  notifyGiftCardOpsEvent({
    phase: "payment-pending",
    status: "pending",
    order: pending,
    error: error?.constructor.name,
    meta: { reason },
  })
  return pending
}

/**
 * Nothing left the wallet. Returns the PAYMENT_FAILED row, or — if a
 * concurrent same-key attempt already recorded an outcome — that row, or — if
 * the write itself failed — the order as last known, logged; the client reads
 * the row's true state on its next poll either way.
 */
const markPaymentFailed = async (
  order: GiftCardOrder,
  reason: string,
  error: ApplicationError | null,
  providerPaymentRef: string | null,
): Promise<GiftCardOrder> => {
  const repo = GiftCardOrdersRepository()
  const failed = await repo.transition({
    id: order.id,
    from: [GiftCardOrderStatus.InvoiceIssued, GiftCardOrderStatus.PaymentPending],
    to: GiftCardOrderStatus.PaymentFailed,
    reason,
    patch: { failureReason: reason, ...refPatch(providerPaymentRef) },
  })
  if (failed instanceof GiftCardOrderStateError) {
    // A concurrent attempt got there first and has already reported whatever
    // it recorded. Whatever it wrote is the truth; do not report it twice.
    const latest = await repo.findById(order.id)
    baseLogger.warn(
      {
        orderId: order.id,
        reason,
        rowStatus: latest instanceof Error ? "unreadable" : latest.status,
      },
      "Gift card payment failed but a concurrent attempt already moved the order",
    )
    return latest instanceof Error ? order : latest
  }
  if (failed instanceof Error) {
    recordExceptionInCurrentSpan({ error: failed })
    baseLogger.error(
      { orderId: order.id, reason, error: failed.constructor.name },
      "Could not mark gift card order PAYMENT_FAILED",
    )
  }
  notifyGiftCardOpsEvent({
    phase: "order-failed",
    status: "failed",
    order,
    error: error?.constructor.name ?? "PaymentSendStatusFailure",
    meta: { reason },
  })
  return failed instanceof Error ? order : failed
}

const markPaidAndSettle = async (
  order: GiftCardOrder,
  invoiceSats: Satoshis,
  providerPaymentRef: string | null,
): Promise<GiftCardOrder | ApplicationError> => {
  const repo = GiftCardOrdersRepository()
  const patch = { paidSats: invoiceSats, ...refPatch(providerPaymentRef) }
  const notRecorded = (cause: ApplicationError, rowStatus?: GiftCardOrderStatus) =>
    paidNotRecorded({
      order,
      providerPaymentRef,
      intended: GiftCardOrderStatus.Paid,
      cause,
      rowStatus,
    })

  let paid = await repo.transition({
    id: order.id,
    from: [GiftCardOrderStatus.InvoiceIssued, GiftCardOrderStatus.PaymentPending],
    to: GiftCardOrderStatus.Paid,
    reason: "payment-settled",
    patch,
  })
  if (paid instanceof GiftCardOrderStateError) {
    // The row is no longer INVOICE_ISSUED / PAYMENT_PENDING. Either a
    // concurrent same-key attempt recorded the outcome first, or the reconcile
    // worker expired the row while this send was in flight at IBEX.
    const latest = await repo.findById(order.id)
    if (latest instanceof Error) return notRecorded(latest)
    if (latest.status === GiftCardOrderStatus.Expired) {
      // The invoice outlived its expiry on our books, not at IBEX: the money
      // left. EXPIRED → PAID exists for exactly this.
      paid = await repo.transition({
        id: order.id,
        from: [GiftCardOrderStatus.Expired],
        to: GiftCardOrderStatus.Paid,
        reason: "payment-settled-after-expiry",
        patch,
      })
      if (paid instanceof GiftCardOrderStateError) {
        const again = await repo.findById(order.id)
        if (again instanceof Error) return notRecorded(again)
        if (MONEY_MOVED_STATUSES.includes(again.status)) return again
        return notRecorded(paid, again.status)
      }
    } else if (MONEY_MOVED_STATUSES.includes(latest.status)) {
      return latest
    } else {
      return notRecorded(paid, latest.status)
    }
  }
  if (paid instanceof Error) return notRecorded(paid)
  notifyGiftCardOpsEvent({ phase: "order-paid", status: "success", order: paid })

  // One immediate look: most vendors fulfil within seconds of payment, and a
  // card in the mutation response is a better experience than a push a moment
  // later. No retries — the customer is waiting on this response and the
  // reconcile worker asks again in seconds. A vendor error here is NOT the
  // order's error — PAID is returned and the worker finishes the job.
  const settled = await fetchAndSettle(paid, { retry: false })
  if (settled instanceof Error) {
    baseLogger.info(
      { orderId: paid.id, error: settled.constructor.name },
      "First fulfilment poll did not settle; reconcile worker will retry",
    )
    return paid
  }
  return settled
}
