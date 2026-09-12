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
                                                          | pending -> leave (IBEX's word beats a vendor poll)
                                                          | unknown / no ref -> fetchAndSettle ------------->|
                                                          |            fulfilled -> PAID -> FULFILLED
                                                          |            else leave; warn after 60 min
```

An order with **no** `providerPaymentRef` (the send errored before IBEX handed
back an id, or a crash between the IBEX call and the transition that writes
it) answers "unknown" every run: there is no hash-based fallback on the IBEX
rail. The worker asks the vendor instead: a vendor `fulfilled` is proof of
payment (below). An order the vendor cannot vouch for either stays pending;
RUNBOOK (c) after 60 min.

### 4a. A send error without a verdict

`purchaseGiftCard` files a send error under `PAYMENT_FAILED` only when the
error proves IBEX never accepted the send: a send-guard rejection (the guard
runs immediately before the IBEX call), `InvalidIdempotencyKeyError` /
`IdempotencyKeyReuseError` (the wrapper refused before executing),
`InsufficientIbexBalance` (IBEX's 400), `FailedIbexPayment` (a corroborated
FAILED on the 200). Every other error (the generic `IbexError` for a socket
reset, gateway 5xx or timeout after the request was accepted;
`UnconfirmedIbexPayment`; `CompletedInvoice`; a busy idempotency lock while a
concurrent same-key attempt is in flight) says nothing about whether money
moved, so the order goes `INVOICE_ISSUED -> PAYMENT_PENDING` with reason
`payment-unconfirmed: <Error>` in `statusHistory` (`[ops: payment-pending]`,
`error` naming the class) and the **pending order** is returned. This flow
then settles it. A replayed order that lost to a concurrent attempt returns
whatever that attempt wrote.

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

After `GIFT_CARD_PAID_TIMEOUT_MS` (24 h) in `PAID`, `processPaid` makes one
final `fetchAndSettle` before escalating: a vendor `fulfilled` ends
`FULFILLED` (a worker gap over 24 h must not refund cards that shipped), a
vendor `failed` / `refunded` takes the path above, and only otherwise —
including a vendor error, which the event names in `meta.lastVendorPoll` — does
it write `REFUND_REQUIRED` with reason `fulfillment-timeout`. From here on the
order is an operator's problem: RUNBOOK (a). The customer must not be told to
buy again.

## 6. Expiry

```ascii
Worker                              Repo                      IBEX
 | listByStatus(CREATED, INVOICE_ISSUED)                       |
 | filter expiresAt < now             |                        |
 | processExpiry:                     |                        |
 |   INVOICE_ISSUED? lookupSentPaymentStatus ----------------->|
 |     settled -> settleAsPaid (payment-settled-on-reconcile)  |
 |     pending -> warn, do not expire                          |
 |     unknown -> fetchAndSettle (vendor): fulfilled -> PAID -> FULFILLED
 |     failed / vendor has nothing -> fall through             |
 |   transition CREATED|INVOICE_ISSUED->EXPIRED (reason expired)
 |   [ops: order-failed, reason expired]                       |
```

`expiresAt` is `min(order TTL 15 min, decoded BOLT11 expiry, vendor-stated
expiry if the adapter reports one)` set at INVOICE_ISSUED; TBC reports none, so
the invoice governs. An order that reached INVOICE_ISSUED but crashed before the
IBEX call has no payment and is correctly expired. An order that crashed *after*
the IBEX call but before the transition that writes `providerPaymentRef` looks
the same to IBEX, so the worker asks the vendor before expiring it: a card that
shipped is proof of payment and the order settles. Only an invoice neither IBEX
nor the vendor knows as paid is expired. (A same-key replay before expiry
resumes the payment instead: flow 7.)

## 7. Idempotent replay / double tap

```ascii
App                    API                    UC                          Repo
 | giftCardPurchase(key K, P, V, Q)            |                            |
 |--------------------->|--------------------->| findByIdempotencyKey(wallet, K) --> hit
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

The replay never reaches the vendor and never spends attempt budget beyond the
single `consumeLimiter` call at the top. A replay of an order that already
paid also cannot re-pay: even if the row check were bypassed,
`withPaymentIdempotency` returns the cached result for `giftcard:<orderId>` and
`onResponse` does not run, so `providerPaymentRef` stays whatever the first
call wrote.

**Resumed INVOICE_ISSUED.** A first attempt that died between issuing the
invoice and recording the payment's outcome leaves a row that, handed back as
"keep polling", could only ever end in `EXPIRED` — writing the money off if
IBEX had in fact paid. So the replay re-enters `payLnInvoiceViaIbex` (send
guard, IBEX, the same transitions as flow 1/4/4a) under the same
`giftcard:<orderId>` key: a cached outcome is replayed, an in-flight attempt is
refused (busy lock -> `PAYMENT_PENDING`, flow 4a), or the one send that never
happened is made. Nothing upstream of the pay step (gate, quote, limits,
vendor) runs again. Not resumed: `CREATED` (vendor `createOrder` is not
idempotent), an `INVOICE_ISSUED` row past `expiresAt` (flow 6 handles it), and
any row while `giftCards.enabled` is false (that would be new money leaving;
the worker still settles an invoice the first attempt did pay).
