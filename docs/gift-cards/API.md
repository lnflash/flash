# Gift Cards GraphQL API Reference

All fields require an authenticated session (`GraphQLPublicContextAuth`).
`giftCardCatalog` and `giftCardQuote` open with `gateGiftCardsForAccount`
(`src/graphql/public/root/gift-card-gate.ts`) and throw the mapped error.
`giftCardPurchase` does **not** gate at the resolver: `purchaseGiftCard` gates
after its same-key replay lookup, so a retry of a timed-out purchase still
finds its order once the kill switch is off, and a fresh purchase while the
rail is off gets `GIFT_CARDS_DISABLED` in `errors` from the app layer.
`giftCardOrder` and `giftCardOrders` are **not** gated at all: they are
owner-scoped reads of orders the customer already paid for, and switching the
rail off must never hide codes they own. Ownership is enforced in the app layer
(`getGiftCardOrderForAccount` answers not-found for a non-owner). Money on
products, quotes and orders is in **minor units** of the product currency
(`CentAmount`); what the customer pays is in sats (`SatAmount`).

Resolvers on disk at the time of writing:
`src/graphql/public/root/query/gift-card-catalog.ts`, `gift-card-quote.ts`,
`gift-card-order.ts`, `gift-card-orders.ts`,
`src/graphql/public/root/mutation/gift-card-purchase.ts`, wired in
`src/graphql/public/queries.ts` and `mutations.ts`.

## `globals.giftCardsEnabled`

`Boolean!` on `Globals` (`src/graphql/public/types/object/globals.ts`,
resolved in `root/query/globals.ts`). True only when `giftCards.enabled` is on
**and** at least one provider is both enabled and registered by an adapter
(`isGiftCardProviderEnabled`). When false, hide every gift card
entry point: `giftCardCatalog`, `giftCardQuote` and a fresh `giftCardPurchase`
refuse. `giftCardOrder` and `giftCardOrders` keep resolving so a customer can
always reach a card they already bought.

## Queries

### `giftCardCatalog`

```graphql
query GiftCardCatalog($countryCode: CountryCode, $first: Int, $after: String) {
  giftCardCatalog(countryCode: $countryCode, category: null, search: null, first: $first, after: $after) {
    edges {
      cursor
      node {
        id name brand countryCode currency
        denominationType   # FIXED | VARIABLE
        denominations minValue maxValue wholeUnitsOnly
        maxQuantity isOpenLoop categories logoUrl termsUrl rewardBps
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

- `countryCode` defaults to the calling account's country, which is also what
  the purchase routes by. Browsing another country's catalog is allowed; buying
  from it is refused with `GIFT_CARD_PRODUCT_NOT_AVAILABLE_IN_COUNTRY`.
- In stock only; open-loop cards only when `giftCards.allowOpenLoop` is on.
  Ordered by brand, name, id. `first` 1..200, default 50. An unknown `after`
  restarts from the top (repeat possible, never a gap).
- `maxQuantity` (1 for TBC) is the most cards one order may hold;
  `wholeUnitsOnly` is true when a VARIABLE card takes whole currency units
  only (no cents). Both are enforced at quote and purchase
  (`GIFT_CARD_INVALID_VALUE`).
- Served from Redis. A stale catalog is still served; a missing one throws
  `GIFT_CARD_CATALOG_UNAVAILABLE`. Each sync deletes the keys of cards the
  vendor de-listed, so a removed card stops being quotable at once; rows cached
  before `maxQuantity` / `wholeUnitsOnly` existed read as 1 / false until the
  next sync rewrites them.

### `giftCardQuote`

```graphql
query GiftCardQuote($productId: ID!, $value: CentAmount!, $quantity: Int) {
  giftCardQuote(productId: $productId, value: $value, quantity: $quantity) {
    productId value currency quantity
    fiatCost      # vendor charge for the whole order, minor units
    satsCost      # what leaves the wallet; show this as the price
    rewardSats
    expiresAt
  }
}
```

Refuses exactly what the purchase would refuse (same first steps, same
errors), so the client can surface problems before the confirm screen. Not a
reservation: nothing is held, no purchase limit is consumed; only the 30/min
quote attempt budget is charged. Quotes are good for ~60 s (`QUOTE_TTL_MS`);
the purchase re-quotes regardless.

### `giftCardOrder`

```graphql
query GiftCardOrder($id: ID!) {
  giftCardOrder(id: $id) {
    id status product { name brand countryCode currency isOpenLoop logoUrl }
    value currency quantity paidSats createdAt fulfilledAt failureReason
    claim { codes { label value } claimLink barcode { chars type } }
  }
}
```

The endpoint to poll after a purchase and the **only** place `claim` is
returned. Returns `null` for an unknown id **and** for another account's
order; the two are deliberately indistinguishable
(`getGiftCardOrderForAccount`). Not behind the master gate (see the top of
this page). `paidSats` is the vendor invoice amount, excluding the Lightning
routing fee.

`failureReason` is a short machine-oriented string for support and
diagnostics (`vendor-create-failed: GiftCardVendorRejectedOrderError`,
`quote-mismatch: quoted 41234 invoiced 42000`, `expired`,
`fulfillment-timeout`, `payment-unresolved-expired`, ...). It is **not**
customer copy; choose the wording from `status`.

**Claim rule.** `claim` is non-null only when all of the following hold: the
caller owns the order, `status` is `FULFILLED`, and the ciphertext decrypts
under the currently configured key for this order. This is enforced twice: the
app layer decrypts only for the owner once fulfilled, and
`toGiftCardOrderSource` drops any claim unless `status === FULFILLED`. A
`FULFILLED` order whose claim cannot be decrypted (key missing, rotated, or one
pod on stale config) is **still returned**, with `claim: null`, so the
customer can always see the order they paid for; the fault is recorded
server-side at Critical (span + log, never the ciphertext) rather than thrown
to the client. Only `giftCardPurchase` surfaces it, as
`GIFT_CARD_CLAIM_UNAVAILABLE` alongside the order. A client polling
`giftCardOrder` that sees `FULFILLED` with `claim: null` should show "contact
support" and keep polling; the claim appears once the key is restored.

### `giftCardOrders`

```graphql
query GiftCardOrders($first: Int, $after: String) {
  giftCardOrders(first: $first, after: $after) {
    edges { cursor node { id status product { brand } value currency quantity createdAt } }
    pageInfo { hasNextPage endCursor }
  }
}
```

Newest first, keyset-paged on `createdAt` (cursor = base64 ISO timestamp).
`first` 1..100, default 20. `claim` is always null in a listing. Not behind
the master gate.

## Mutation

### `giftCardPurchase`

```graphql
mutation GiftCardPurchase($input: GiftCardPurchaseInput!) {
  giftCardPurchase(input: $input) {
    errors { message code }
    order {
      id status paidSats failureReason
      claim { codes { label value } claimLink barcode { chars type } }
    }
  }
}
```

`GiftCardPurchaseInput`: `productId: ID!`, `value: CentAmount!` (one card),
`quantity: Int` (1..10 and at most the product's `maxQuantity`, default 1),
`walletId: WalletId!` (must belong to the caller), `idempotencyKey: String!`
(8 to 64 chars, no whitespace; a UUID is ideal).

Behaviour:

- Re-prices at order time and refuses to pay if the vendor invoice drifted past
  `quoteToleranceBps` from the quote. No money moves on any refusal.
- Money moves at most once per `idempotencyKey`. Retry a timed-out call with
  the **same** key: same key + same parameters returns the existing order in
  whatever state it reached, without spending the attempt budget; same key +
  different parameters is refused. One exception: an `INVOICE_ISSUED` order
  still inside its expiry is **resumed**, not returned. The server re-enters
  the payment step under its own server-side key (`giftcard:<orderId>`), so a
  first call that died mid-payment is finished (cached outcome replayed, or
  the one send that never happened made) rather than left to expire. If that
  key's lock is busy (the first call is still in flight) the current row is
  returned unchanged. `CREATED` is returned as-is.
- Once IBEX has answered, `order` is **always** returned: often already
  `FULFILLED` with `claim` attached, otherwise `PAID` or `PAYMENT_PENDING`
  (poll `giftCardOrder`). A send whose outcome IBEX could not confirm (network
  fault, gateway error or timeout after the request was accepted) comes back
  as a `PAYMENT_PENDING` order, **not** as an error: poll, do not buy again. A
  bookkeeping failure after a successful send (the PAID write lost) raises a
  Critical `paid-not-recorded` ops event on the Flash side and still returns
  the order. `FAILED` / `PAYMENT_FAILED` orders are returned with
  `failureReason`. `order` is absent only when refused before a row existed.
  It can be present **alongside** an error when the card was issued but the
  claim could not be read.
- Attempt budget: 10 per minute per account, 5-minute block
  (`RateLimitConfig.giftCardPurchase`), charged before any vendor call on a
  fresh attempt; a same-key replay does not consume it.

### `GiftCardOrderStatus`

| Value | Meaning for the client |
| --- | --- |
| `CREATED`, `INVOICE_ISSUED`, `PAYMENT_PENDING`, `PAID` | Transient. Keep polling. Never purchase again. `PAYMENT_PENDING` can take minutes: the worker re-reads IBEX and, when IBEX cannot account for the send, asks the vendor. A vendor `disputed` is held as pending, not refunded: the order stays `PAID` until TBC resolves it or the 24 h timeout |
| `FULFILLED` | Terminal. `claim` and `fulfilledAt` are set |
| `FAILED` | Terminal, nothing paid: vendor rejected, price moved past tolerance, or unreadable invoice. Safe to retry with a new key |
| `PAYMENT_FAILED` | Terminal, nothing paid: IBEX **provably** refused or failed the Lightning payment (insufficient balance, a corroborated payment failure, a send-guard rejection), or a pending send with no IBEX ref that the vendor reports unpaid 24 h past expiry (`payment-unresolved-expired`). Safe to retry with a new key |
| `EXPIRED` | Terminal, nothing paid: invoice not paid in time. (A late IBEX Success can still move it to `PAID`; keep showing the latest `status`) |
| `REFUND_REQUIRED` | Terminal. The wallet paid, no card arrived; Flash has been paged. Do **not** tell the customer to buy again |

## Error codes

From `src/graphql/error-map.ts`. On queries they arrive as a GraphQL error with
`extensions.code`; on the mutation as `errors[].code`.

| Code | Fires when | Client should |
| --- | --- | --- |
| `GIFT_CARDS_DISABLED` | `giftCards.enabled` is off (catalog, quote, a fresh purchase) | Hide the feature; `globals.giftCardsEnabled` should already be false |
| `GIFT_CARD_PROVIDER_UNAVAILABLE` | No registered and enabled provider routed for the account's country | "Not available in your region"; deterministic until config changes |
| `GIFT_CARD_PRODUCT_NOT_FOUND` | Malformed id, unknown provider prefix, cache miss, out of stock, or an open-loop card hidden by `allowOpenLoop` (catalog, quote and purchase all answer this) | Refresh the catalog |
| `GIFT_CARD_PRODUCT_NOT_AVAILABLE_IN_COUNTRY` | Product's provider is not the one routed for the account, or the product's `countryCode` differs from the account's known country (skipped when the country is unknown, `"XX"`). Enforced at quote and purchase | Show the account-country catalog |
| `GIFT_CARD_INVALID_VALUE` | Value not a listed denomination / outside min..max / not whole units when `wholeUnitsOnly`, quantity not 1..10 or above `maxQuantity`, or the vendor's quote endpoint returned a 4xx for the value | Fix the input from the product's denomination fields |
| `GIFT_CARD_LIMIT_EXCEEDED` | Limits `enforce` mode: account too new, per-card, daily, vendor cap, or velocity | Show the message; it names the cap |
| `GIFT_CARD_LEVEL_NOT_ELIGIBLE` | Level 0, below `minAccountLevel`, or level < 2 for open-loop (enforce mode) | Route to the account upgrade flow, not a retry |
| `GIFT_CARD_QUOTE_MISMATCH` | Vendor invoice exceeded the quote by more than tolerance; order is `FAILED`, nothing paid | Re-quote and retry with a new key |
| `GIFT_CARD_ORDER_NOT_FOUND` | Not thrown by `giftCardOrder` (returns null); can surface from internal reads | Treat as not found |
| `GIFT_CARD_ORDER_STATE` | An illegal transition was attempted (e.g. INVOICE_ISSUED write lost a race) | Poll `giftCardOrder`; do not retry the purchase |
| `GIFT_CARD_VENDOR_REJECTED` | Vendor returned a definitive 4xx on order creation, or an unreadable invoice; `FAILED`, nothing paid. The message is a fixed customer string; the vendor's text stays in logs | Show message; retry later with a new key |
| `GIFT_CARD_VENDOR_UNAVAILABLE` | Vendor unreachable, 5xx, auth failure, or unexpected response shape | "Temporarily unavailable"; retry later |
| `GIFT_CARD_CATALOG_UNAVAILABLE` | Catalog key missing from Redis or Redis unreadable | Retry later; the sync job repopulates |
| `GIFT_CARD_CLAIM_UNAVAILABLE` | Claim ciphertext could not be decrypted (key missing, rotated, corrupt, or bound to another order). Returned only by `giftCardPurchase`, alongside the order; `giftCardOrder` returns the order with `claim: null` instead | Show "contact support"; the order is still `FULFILLED` |
| `GIFT_CARD_IDEMPOTENCY_KEY_REUSE` | Same key, different product/value/quantity | Generate a new key for a new purchase |
| `GIFT_CARD_PURCHASE_RATE_LIMITED` | More than 10 fresh purchase attempts in a minute (replays do not count) | Back off 5 minutes |
| `GIFT_CARD_QUOTE_RATE_LIMITED` | More than 30 `giftCardQuote` calls in a minute | Back off 5 minutes; reuse the last quote until its `expiresAt` |
| `GIFT_CARD_UNKNOWN` | Limits store unreadable (`limits-unavailable` in enforce mode) or an adapter threw | Retry later; this pages on the Flash side |

Errors that are **not** `GIFT_CARD_*` can also come back from the mutation:
scalar validation (`CentAmount`, `WalletId`) and a bad `idempotencyKey` length
return a plain `errors[].message` with no code; a wallet that does not belong
to the caller is a generic validation error; and the payment step passes
through the send guard's and IBEX's own errors (e.g. rate limit or limit
errors from `authorizeSend`, `IbexError` subclasses) with their existing codes
**only when they prove IBEX never accepted the send**; anything after that is
an order, not an error.
