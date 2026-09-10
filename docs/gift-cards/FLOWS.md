# Gift Card Flows

Function names are the real ones. `App` is the mobile client, `API` the
resolver in `src/graphql/public/root/mutation/gift-card-purchase.ts`, `UC` the
use case in `src/app/gift-cards/`, `Repo` `GiftCardOrdersRepository`, `Vendor`
the `IGiftCardProvider` adapter, `IBEX` the payment rail via
`payLnInvoiceViaIbex`, `Worker` `reconcileGiftCardOrders`.

Every purchase opens the same way (steps 1-7 below): gate, product, validate,
`provider.quote`, `authorizeGiftCardPurchase`, `repo.create` (CREATED),
`releaseGiftCardReservation`. The diagrams that follow start after that unless
they say otherwise.

## 1. Purchase, happy path

```ascii
App            API                UC (purchaseGiftCard)      Repo         Vendor        IBEX
 |  giftCardPurchase(input)         |                           |            |             |
 |------------->|                   |                           |            |             |
 |              | gateGiftCardsForAccount                       |            |             |
 |              |------------------>| consumeLimiter (10/min)   |            |             |
 |              |                   | findByIdempotencyKey  --> | (miss)     |             |
 |              |                   | giftCardsMasterGate       |            |             |
 |              |                   | getGiftCardProduct (Redis)|            |             |
 |              |                   | checkedGiftCardValue/Quantity          |             |
 |              |                   | provider.quote ------------------------>|             |
 |              |                   | authorizeGiftCardPurchase (limits, hold)|             |
 |              |                   | repo.create  ------------>| CREATED    |             |
 |              |                   | releaseGiftCardReservation|            |             |
 |              |                   | [ops: order-created]      |            |             |
 |              |                   | provider.createOrder(reference=orderId)>|             |
 |              |                   |                <-- { providerOrderId, bolt11, sats } |
 |              |                   | decodeInvoice + tolerance check        |             |
 |              |                   | transition CREATED->INVOICE_ISSUED --> |             |
 |              |                   | payLnInvoiceViaIbex(key giftcard:<id>) ------------->|
 |              |                   |   authorize: send guard, then Ibex.payInvoice        |
 |              |                   |   onResponse: capture transaction.id                 |
 |              |                   |                                <-- Success           |
 |              |                   | transition INVOICE_ISSUED->PAID (paidSats, ref) -->|  |
 |              |                   | [ops: order-paid]         |            |             |
 |              |                   | fetchAndSettle -> provider.getOrder --->|             |
 |              |                   |                        <-- fulfilled + claim         |
 |              |                   | settleOrderFromVendor: encryptGiftCardClaim          |
 |              |                   | transition PAID->FULFILLED (ciphertext, keyId) ---->|  |
 |              |                   | [ops: order-fulfilled] + push notification           |
 |              |<------------------| FULFILLED order           |            |             |
 |              | getGiftCardOrderForAccount (decrypt for owner)             |             |
 |<-------------| { order: FULFILLED, claim }                                |             |
```

If the first `fetchAndSettle` returns pending or errors, the mutation returns
the `PAID` order and the worker finishes the job (flow 4's second half).

## 2. Vendor rejects the order

```ascii
UC (purchaseGiftCard)          Repo              Vendor
 | repo.create -------------->| CREATED          |
 | provider.createOrder ---------------------->|
 |            <-- 4xx with message (GiftCardVendorRejectedOrderError)
 |            or 5xx / network (GiftCardVendorUnavailableError)
 | failUnpaidOrder:            |                  |
 |   transition CREATED->FAILED (reason vendor-create-failed: <ErrorName>)
 |   [ops: order-failed]       |                  |
 | return error  -> API returns { errors: [GIFT_CARD_VENDOR_REJECTED
 |                                  | GIFT_CARD_VENDOR_UNAVAILABLE] }
```

Nothing was paid. The client may retry with a **new** idempotency key. The
same applies to an undecodable invoice (`vendor-invoice-undecodable`).

## 3. Quote mismatch

```ascii
UC                              Repo            Vendor
 | provider.quote ------------------------------>|   satsCost = Q
 | repo.create -----------------> CREATED        |
 | provider.createOrder ------------------------>|   bolt11 for S sats, amountSats = A
 | invoiceSats = decode(bolt11).amount           |
 | charged = max(invoiceSats, A)                 |
 | max = floor(Q * (1 + quoteToleranceBps/10000))|
 | charged > max ?                               |
 |   failUnpaidOrder: CREATED->FAILED            |
 |     reason "quote-mismatch: quoted Q invoiced charged"
 |     [ops: order-failed]                       |
 |   return GiftCardQuoteMismatchError -> GIFT_CARD_QUOTE_MISMATCH
```

The vendor's invoice is left unpaid and expires on its side. The customer sees
"The gift card price changed; please try again" and re-quotes.

## 4. Payment pending, settled by the worker

```ascii
UC                     Repo                 IBEX                  Worker (30s)         Vendor
 | payLnInvoiceViaIbex ----------------------->|                     |                    |
 |                  <-- Pending (transaction.id captured)            |                    |
 | INVOICE_ISSUED->PAYMENT_PENDING (providerPaymentRef) |            |                    |
 | [ops: payment-pending]; return PAYMENT_PENDING order  |            |                    |
                                                          | listByStatus(PAYMENT_PENDING) |
                                                          | lookupSentPaymentStatus:      |
                                                          |   Ibex.getTransactionDetails(ref)
                                                          |   paymentSendStatusFromIbex   |
                                                          | settled -> settleAsPaid:      |
                                                          |   PAYMENT_PENDING->PAID       |
                                                          |   [ops: order-paid]           |
                                                          |   fetchAndSettle ------------>|
                                                          |          <-- fulfilled+claim  |
                                                          |   PAID->FULFILLED, push       |
                                                          | failed  -> PAYMENT_PENDING->PAYMENT_FAILED
                                                          |            [ops: order-failed]
                                                          | pending/unknown -> leave; warn after 60 min
```

An order with **no** `providerPaymentRef` (crash between the IBEX call and the
transition that writes it) answers "unknown" every run: there is no
hash-based fallback on the IBEX rail. See RUNBOOK (c).

If the vendor reports `fulfilled` while Flash still shows `INVOICE_ISSUED` or
`PAYMENT_PENDING`, `settleOrderFromVendor` treats the vendor's word as proof of
payment and moves the order to `PAID` (reason `vendor-reported-fulfilled`) and
then `FULFILLED`.

## 5. Paid, then the vendor cancels (REFUND_REQUIRED)

```ascii
Worker                        Repo                   Vendor
 | listByStatus(PAID)          |                      |
 | nextGiftCardPollAt due?     |                      |
 | fetchAndSettle -> provider.getOrder(providerOrderId, bolt11) -->|
 |                   <-- { kind: failed | refunded, reason }       |
 | settleOrderFromVendor -> vendorFailed:                          |
 |   order.status == PAID:                                         |
 |     transition PAID->REFUND_REQUIRED (reason vendor-<kind>: <reason>)
 |     [ops: refund-required, status failed]   <- PAGE             |
```

The same terminal state is reached without any vendor answer when an order has
been `PAID` for `GIFT_CARD_PAID_TIMEOUT_MS` (24 h): `processPaid` writes
`REFUND_REQUIRED` with reason `fulfillment-timeout`. From here on the order is
an operator's problem: RUNBOOK (a). The customer must not be told to buy again.

## 6. Expiry

```ascii
Worker                              Repo                      IBEX
 | listByStatus(CREATED, INVOICE_ISSUED)                       |
 | filter expiresAt < now             |                        |
 | processExpiry:                     |                        |
 |   INVOICE_ISSUED? lookupSentPaymentStatus ----------------->|
 |     settled -> settleAsPaid (payment-settled-on-reconcile)  |
 |     pending -> warn, do not expire                          |
 |     unknown/failed -> fall through                          |
 |   transition CREATED|INVOICE_ISSUED->EXPIRED (reason expired)
 |   [ops: order-failed, reason expired]                       |
```

`expiresAt` is `min(now + 15 min, vendor expiry)` set at INVOICE_ISSUED. An
order that reached INVOICE_ISSUED but crashed before the IBEX call has no
payment and is correctly expired. An order that crashed *after* the IBEX call
but before the transition that writes `providerPaymentRef` looks the same to
the worker and is also expired; that is the one documented window where a paid
invoice can be written off, and it is logged.

## 7. Idempotent replay / double tap

```ascii
App                    API                    UC                          Repo
 | giftCardPurchase(key K, P, V, Q)            |                            |
 |--------------------->|--------------------->| findByIdempotencyKey(wallet, K) --> hit
 |                      |                      | providerId/product/value/quantity equal?
 |                      |                      |   yes -> return existing order (any state)
 |                      |                      |          span giftcard.replay=true
 |                      |                      |   no  -> GiftCardIdempotencyKeyReuseError
 |<---------------------|  { order } or { errors: [GIFT_CARD_IDEMPOTENCY_KEY_REUSE] }

Concurrent double tap (both miss the lookup):
 |  tap 1 --> repo.create -> CREATED (wins the unique index)
 |  tap 2 --> repo.create -> GiftCardOrderDuplicateKeyError
 |            -> findByIdempotencyKey again -> returns tap 1's order
 |  tap 1 continues alone to the vendor and IBEX.
```

The replay never reaches the vendor and never spends attempt budget beyond the
single `consumeLimiter` call at the top. A replay of an order that already
paid also cannot re-pay: even if the row check were bypassed,
`withPaymentIdempotency` returns the cached result for `giftcard:<orderId>` and
`onResponse` does not run, so `providerPaymentRef` stays whatever the first
call wrote.
