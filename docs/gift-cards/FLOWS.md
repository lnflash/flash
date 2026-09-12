# Gift Card Flows

Function names are the real ones. `App` is the mobile client, `API` the
resolver in `src/graphql/public/root/mutation/gift-card-purchase.ts`, `UC` the
use case in `src/app/gift-cards/`, `Repo` `GiftCardOrdersRepository`, `Vendor`
the `IGiftCardProvider` adapter, `IBEX` the payment rail via
`payLnInvoiceViaIbex`, `Worker` `reconcileGiftCardOrders`.

Every purchase opens as flow 1 up to `repo.create`: wallet ownership, the
same-key replay lookup (a hit returns or resumes the existing order and charges
nothing, flow 7), `consumeLimiter`, gate, claim-key check, product, validation
(value, `wholeUnitsOnly`, quantity up to `maxQuantity`, product country vs
account country), `provider.quote`, `authorizeGiftCardPurchase`, `repo.create`
(CREATED), `releaseGiftCardReservation`. Later diagrams start after that.

## 1. Purchase, happy path

```ascii
App            API                UC (purchaseGiftCard)      Repo         Vendor        IBEX
 |  giftCardPurchase(input)         |                           |            |             |
 |------------->| (no gate here)    |                           |            |             |
 |              |------------------>| wallet belongs to account |            |             |
 |              |                   | findByIdempotencyKey  --> | (miss)     |             |
 |              |                   | consumeLimiter (10/min)   |            |             |
 |              |                   | giftCardsMasterGate       |            |             |
 |              |                   | giftCardClaimKeyId loads? |            |             |
 |              |                   | getGiftCardProduct (Redis)|            |             |
 |              |                   | checkedGiftCardValue/Quantity, country |             |
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

If the first `fetchAndSettle` is pending or errors, the mutation returns the
`PAID` order and the worker finishes the job (flow 4's second half).

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

Nothing was paid; the client may retry with a **new** key. Same for an
undecodable invoice (`vendor-invoice-undecodable`). The `GIFT_CARD_VENDOR_REJECTED`
message is a fixed customer string; the vendor's own text is logged, not relayed.

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

The vendor's invoice expires unpaid on its side; the customer re-quotes.

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
                                                          | pending -> leave (IBEX's word beats a vendor poll)
                                                          | unknown / no ref -> fetchAndSettle ------------->|
                                                          |            fulfilled -> PAID -> FULFILLED
                                                          |            not paid AND now > expiresAt + 24h
                                                          |              -> PAYMENT_FAILED (payment-unresolved-expired)
                                                          |            else leave; warn after 60 min
```

An order with **no** `providerPaymentRef` (the send errored before IBEX handed
back an id, or a crash between the IBEX call and the transition that writes
it) answers "unknown" every run: there is no hash-based fallback on the IBEX
rail, so the worker asks the vendor; a vendor `fulfilled` is proof of payment
(below). While the vendor reports the invoice unpaid the order stays pending
(RUNBOOK c after 60 min) until 24 h past `expiresAt`, when it is closed as
`PAYMENT_FAILED` (`payment-unresolved-expired`). A vendor error leaves it
pending for the next run.

### 4a. A send error without a verdict

`purchaseGiftCard` files a send error under `PAYMENT_FAILED` only when the
error proves IBEX never accepted the send: a send-guard rejection (the guard
runs immediately before the IBEX call), `InvalidIdempotencyKeyError` /
`IdempotencyKeyReuseError` (the wrapper refused before executing),
`InsufficientIbexBalance` (IBEX's 400), `FailedIbexPayment` (a corroborated
FAILED on the 200). Every other error (the generic `IbexError` for a socket
reset, gateway 5xx or timeout after the request was accepted;
`UnconfirmedIbexPayment`; `CompletedInvoice`) says nothing about whether money
moved, so the order goes `INVOICE_ISSUED -> PAYMENT_PENDING` with reason
`payment-unconfirmed: <Error>` (`[ops: payment-pending]`, `error` naming the
class) and the **pending order** is returned. A 200 naming no recognised status
is converted to `Pending` by `paymentSendStatusOrPending` and lands the same
way with reason `payment-pending`. This flow then settles it. A replayed order
that lost to a concurrent attempt returns whatever that attempt wrote.

Once IBEX has answered, the mutation always returns the order. If the `PAID`
write fails after a Success (lost race, store fault) the order is re-read and
returned as it stands and a Critical `paid-not-recorded` event fires (RUNBOOK
i): an error payload would read as "nothing happened" for money already gone.
A Success for a row the worker expired while the send was in flight is written
`EXPIRED -> PAID` (`payment-settled-after-expiry`).

If the vendor reports `fulfilled` while Flash still shows `INVOICE_ISSUED` or
`PAYMENT_PENDING`, `settleOrderFromVendor` takes the vendor's word as proof of
payment: `PAID` (reason `vendor-reported-fulfilled`), then `FULFILLED`.

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

After `GIFT_CARD_PAID_TIMEOUT_MS` (24 h) in `PAID`, `processPaid` makes one
final `fetchAndSettle` before escalating: a vendor `fulfilled` ends `FULFILLED`
(a worker gap over 24 h must not refund cards that shipped), `failed` /
`refunded` takes the path above, and **only** a positive not-fulfilled answer
(`awaitingPayment` / `paidPendingFulfillment`) writes `REFUND_REQUIRED` with
reason `fulfillment-timeout`. A vendor error keeps the order `PAID` (warned)
and the next run polls again; a page never rests on an unreachable vendor.
TBC's `disputed` is held as pending, not refunded, so it reaches this point
only via the timeout. From here the order is an operator's problem: RUNBOOK (a).
The customer must not be told to buy again.

## 6. Expiry

```ascii
Worker                              Repo                      Vendor
 | listByStatus(CREATED, INVOICE_ISSUED)                       |
 | filter expiresAt < now             |                        |
 | processExpiry:                     |                        |
 |   INVOICE_ISSUED? fetchAndSettle (vendor) --------------------------------->|
 |     fulfilled -> PAID (vendor-reported-fulfilled) -> FULFILLED
 |     anything else (not paid, vendor error) -> fall through  |
 |   transition CREATED|INVOICE_ISSUED->EXPIRED (reason expired)
 |   [ops: order-failed, reason expired]                       |
```

`expiresAt` is `min(order TTL 15 min, decoded BOLT11 expiry, vendor-stated
expiry if the adapter reports one)` set at INVOICE_ISSUED; TBC reports none, so
the invoice governs. There is no IBEX re-read here: an `INVOICE_ISSUED` row
never carries a `providerPaymentRef` (the ref is written with the transition
out of it), so IBEX could only answer "unknown". A row that crashed before the
IBEX call has no payment and is correctly expired; one that crashed *after* the
call but before the ref was written looks the same, so the worker asks the
vendor first: a card that shipped is proof of payment. Two safety nets remain
for a payment that surfaces later: a same-key replay before expiry resumes it
(flow 7), and a late IBEX Success on an `EXPIRED` row is written `EXPIRED ->
PAID` (flow 4a). The worker never polls `EXPIRED`.

## 7. Idempotent replay / double tap

```ascii
App                    API                    UC                          Repo
 | giftCardPurchase(key K, P, V, Q)            |                            |
 |--------------------->|--------------------->| findByIdempotencyKey(wallet, K) --> hit
 |                      |                      | (before consumeLimiter: no budget spent)
 |                      |                      | providerId/product/value/quantity equal?
 |                      |                      |   yes -> return existing order (any state) ...
 |                      |                      |          span giftcard.replay=true
 |                      |                      |          ... EXCEPT INVOICE_ISSUED still inside
 |                      |                      |          expiresAt -> resume the pay step
 |                      |                      |          (giftcard.replay.resumedPayment=true)
 |                      |                      |   no  -> GiftCardIdempotencyKeyReuseError
 |<---------------------|  { order } or { errors: [GIFT_CARD_IDEMPOTENCY_KEY_REUSE] }

Concurrent double tap (both miss the lookup):
 |  tap 1 --> repo.create -> CREATED (wins the unique index)
 |  tap 2 --> repo.create -> GiftCardOrderDuplicateKeyError
 |            -> findByIdempotencyKey again -> returns tap 1's order
 |  tap 1 continues alone to the vendor and IBEX.
```

The replay never reaches the vendor, never runs the master gate (a retry still
finds its order after the kill switch flips; the resolver does not gate
either), and never spends attempt budget (the lookup precedes `consumeLimiter`).
A replay of a paid order cannot re-pay: even past the row check,
`withPaymentIdempotency` returns the cached result for `giftcard:<orderId>` and
`onResponse` does not run, so `providerPaymentRef` stays as first written.

**Resumed INVOICE_ISSUED.** A first attempt that died between issuing the
invoice and recording the payment's outcome leaves a row that, handed back as
"keep polling", could only end in `EXPIRED` — writing the money off if IBEX had
in fact paid. So the replay re-enters `payLnInvoiceViaIbex` (send guard, IBEX,
the transitions of flow 1/4/4a) under the same `giftcard:<orderId>` key: a
cached outcome is replayed, or the one send that never happened is made. If
the key's lock is busy (the first call is still inside IBEX) the current row is
returned **unchanged** — still `INVOICE_ISSUED`, the client polls — rather than
moved to `PAYMENT_PENDING` on a guess. Nothing upstream of the pay step runs
again. Not resumed: `CREATED` (vendor `createOrder` is not idempotent), an
`INVOICE_ISSUED` row past `expiresAt` (flow 6), and any row while
`giftCards.enabled` is false (new money leaving; the worker still settles an
invoice the first attempt did pay).
