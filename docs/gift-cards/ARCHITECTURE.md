# Gift Cards Architecture

## System overview

```ascii
+-------------+   GraphQL    +----------------+   REST (bearer)   +----------------+
|  Mobile App | <----------> | Flash Backend  | <---------------> | Gift card      |
+-------------+              |  (api pod)     |                   | vendor (TBC)   |
                             +----------------+                   +----------------+
                               |     |     ^                              ^
                     Mongo     |     |     | Redis (catalog, locks,        | bolt11
                 (orders)      v     v     |  holds, auth tokens)          | paid by IBEX
                             +-----+ +-----+                      +----------------+
                             |Mongo| |Redis|                      |     IBEX       |
                             +-----+ +-----+                      +----------------+
                               ^                                          ^
                               |  cron (15m) + trigger interval (30s)     |
                             +----------------------------------------------+
                             |  reconcile worker / catalog sync             |
                             +----------------------------------------------+
```

Flash holds no gift card inventory and no balances of its own: user funds sit
at IBEX, so a purchase is a Lightning payment from the user's IBEX account to
the vendor's invoice. Flash's job is ordering, paying exactly once, and
delivering the claim.

## Layers and files

| Layer | Files | Responsibility |
| --- | --- | --- |
| Domain | `src/domain/gift-cards/index.ts`, `index.types.d.ts`, `primitives.ts`, `errors.ts` | Status enum + transition table, product/quote/order/claim types, the `IGiftCardProvider` port, product-id codec, value/quantity validation, every `GiftCard*` error |
| Registry | `src/services/gift-cards/registry.ts`, `index.ts` | Adapters self-register at import; config-driven routing (`routing.byCountry[cc] ?? routing.default`, gated by `providers.<id>.enabled`) for new money; `getRegisteredGiftCardProviderOrError` (registration only, no `enabled` gate) for orders that already exist |
| Adapter (TBC) | `src/services/gift-cards/bitcoin-company/{index,client,mapping,schemas,errors}.ts` | HTTP transport, auth token lifecycle in Redis, retries (idempotent reads only), zod validation, vendor-to-domain mapping. Nothing vendor-shaped leaves this directory |
| Catalog cache | `src/services/gift-cards/catalog-cache.ts` | Redis read model of the catalog; sync job writes, every request reads |
| Claim crypto | `src/services/gift-cards/claim-crypto.ts` | AES-256-GCM at rest for claim data; `claimKeyId` derivation |
| Use cases | `src/app/gift-cards/` | `purchase-gift-card.ts`, `quote-gift-card.ts`, `authorize-purchase.ts` (limits), `reservation-store.ts` (daily-cap holds), `settle-order.ts` (the single settlement path), `reconcile-orders.ts` (worker), `sync-catalog.ts`, `list-products.ts`, `get-order.ts`, `list-orders.ts`, `gift-cards-master-gate.ts`, `ops.ts`, `send-fulfilled-notification.ts` |
| Payment rail | `src/app/payments/pay-invoice-via-ibex.ts` (+ `idempotency.ts`, `authorize-send.ts`) | Pays a bolt11 from the wallet's IBEX account under `withPaymentIdempotency` with the ENG-573 send guard |
| Persistence | `src/services/mongoose/gift-card-orders.ts`, `gift-card-orders.mapping.ts`, `schema.ts` (`GiftCardOrderSchema`), `src/migrations/20260909120000-gift-card-orders-indexes.ts` | `giftcardorders` collection; every status move is one conditional `findOneAndUpdate` |
| GraphQL | `src/graphql/public/root/gift-card-gate.ts`, `root/query/gift-card-{catalog,quote,order,orders}.ts`, `root/mutation/gift-card-purchase.ts`, `types/object/gift-card-{product,quote,order}.ts`, `types/input/gift-card-purchase-input.ts`, `types/payload/gift-card-purchase.ts` | Public contract; see [API.md](API.md) |
| Jobs | `src/servers/cron.ts` (`syncGiftCardCatalogsJob`, `reconcileGiftCardOrdersJob`), `src/servers/trigger.ts` (`startGiftCardReconcileInterval`) | Catalog refresh and the fulfilment safety net |
| Ops events | `src/app/gift-cards/ops.ts`, `src/services/alerts/ops-events.ts` (flow `giftcard`) | Discord funnel; see [ALERTING.md](ALERTING.md) |

Error names all carry the `GiftCard` prefix because `error-map.ts` switches on
the constructor name across every error module; a collision would be a silent
mis-mapping (`src/domain/gift-cards/errors.ts`).

## The provider port

`IGiftCardProvider` (`src/domain/gift-cards/index.types.d.ts`) is pure vendor
I/O. Flash policy (fees, limits, open-loop gating, tolerance) never lives in an
adapter.

| Method | Called by | Notes |
| --- | --- | --- |
| `listProducts()` | `sync-catalog.ts` only | Never on a request path |
| `quote({ product, valueMinor, quantity })` | `quoteGiftCard`, `purchaseGiftCard` | Vendor price in sats, `expiresAt` |
| `createOrder({ product, valueMinor, quantity, reference })` | `purchaseGiftCard` | Returns `providerOrderId`, `paymentRequest` (bolt11), `amountSats`, `expiresAt`. `reference` is our order id, sent as the vendor label. Never retried |
| `getOrder({ providerOrderId, paymentRequest })` | `fetchAndSettle` | Returns `awaitingPayment`, `paidPendingFulfillment`, `fulfilled` (+claim), `failed`, `refunded` |

Provider ids are `bitcoinCompany` and `bitrefill` (`GIFT_CARD_PROVIDER_IDS`).
**Only `bitcoinCompany` has an adapter.** Routing a country to `bitrefill`
yields `GiftCardProviderUnavailableError` because nothing is registered under
that id, whatever `providers.bitrefill.enabled` says.

TBC specifics (`bitcoin-company/mapping.ts`): vendor money is in major units,
the domain is minor units; a `fulfilled` status without claim data is held as
`paidPendingFulfillment` with a warning, never reported fulfilled; unknown
vendor statuses are also held as pending; order status is looked up by
**invoice**, not order id, so `getOrder` refuses a ref with no `paymentRequest`.
Quote TTL (60s) and order TTL (15m) are assumed by the adapter, not returned by
the vendor.

## Routing and the master gate

`giftCardsMasterGate(countryCode)` (`src/app/gift-cards/gift-cards-master-gate.ts`)
checks `giftCards.enabled`, then resolves a provider for the country and
requires it to be enabled. `giftCardCatalog`, `giftCardQuote`,
`giftCardPurchase` and the quote/purchase use cases open with it, so the
catalog can never show what the purchase would refuse. The order reads
(`giftCardOrder`, `giftCardOrders`) are deliberately **not** gated: they are
owner-scoped (`getGiftCardOrderForAccount` answers not-found for a non-owner)
and a customer must be able to reach a card they already paid for while the
rail is off.

The account's country comes from the phone number only (`resolvePhoneCountries`
in `src/app/bridge/kyc-gate.ts`); Bridge KYC stores no country. An ambiguous
calling code (NANP) resolves to the sentinel `"XX"`, which can never match a
`routing.byCountry` entry and so always takes `routing.default`.

## Order state machine

Copied from `GIFT_CARD_TRANSITIONS` (`src/domain/gift-cards/index.ts`):

```
CREATED         -> INVOICE_ISSUED | FAILED | EXPIRED
INVOICE_ISSUED  -> PAYMENT_PENDING | PAID | PAYMENT_FAILED | EXPIRED | FAILED
PAYMENT_PENDING -> PAID | PAYMENT_FAILED
PAID            -> FULFILLED | REFUND_REQUIRED
FULFILLED       -> (terminal)
FAILED          -> (terminal)
PAYMENT_FAILED  -> (terminal)
EXPIRED         -> (terminal)
REFUND_REQUIRED -> (terminal)
```

`REFUND_REQUIRED` is the only state meaning "money left Flash and no card
arrived". `FAILED`, `PAYMENT_FAILED` and `EXPIRED` all mean nothing was paid:
`PAYMENT_FAILED` is written only for a send IBEX provably refused, a send
whose outcome is unknown goes to `PAYMENT_PENDING`, and an expiring invoice is
checked against IBEX and the vendor first.
The repository refuses an illegal move before touching Mongo, and the write is
`findOneAndUpdate({ id, status: { $in: from } })`, so of two racing settlers
exactly one wins and the loser gets `GiftCardOrderStateError`.

Who moves what:

| Transition | Where |
| --- | --- |
| `CREATED -> INVOICE_ISSUED` | `purchaseGiftCard`, after `provider.createOrder` and the tolerance check |
| `CREATED/INVOICE_ISSUED -> FAILED` | `purchaseGiftCard` (`failUnpaidOrder`), `settleOrderFromVendor` on vendor `failed`/`refunded` before payment |
| `INVOICE_ISSUED -> PAID / PAYMENT_PENDING / PAYMENT_FAILED` | `purchaseGiftCard` from the `PaymentSendStatus`, or from the send error's class: a proven refusal is `PAYMENT_FAILED`, anything else `PAYMENT_PENDING` (FLOWS 4a). Also entered by a same-key replay of an unpaid `INVOICE_ISSUED` order |
| `PAYMENT_PENDING -> PAID / PAYMENT_FAILED` | `reconcileGiftCardOrders` (`processPendingPayment`) after re-reading IBEX |
| `INVOICE_ISSUED/PAYMENT_PENDING -> PAID` | `settleOrderFromVendor` when the vendor reports fulfilled before we recorded payment — including the reconcile worker's vendor fallback when IBEX cannot account for the send |
| `CREATED/INVOICE_ISSUED -> EXPIRED` | reconcile (`processExpiry`) past `expiresAt`, after one payment re-read and, when IBEX cannot answer, one vendor poll |
| `PAID -> FULFILLED` | `settleOrderFromVendor` (`fulfil`) with the encrypted claim |
| `PAID -> REFUND_REQUIRED` | `settleOrderFromVendor` on vendor `failed`/`refunded`; reconcile after 24h in PAID when a final vendor poll does not report fulfilled (`fulfillment-timeout`) |

## Decisive facts

**Balances live at IBEX.** The purchase pays with `payLnInvoiceViaIbex`
(`src/app/payments/pay-invoice-via-ibex.ts`), the IBEX-custodial rail that
`lnInvoicePaymentSend` uses. It does **not** use `payInvoiceByWalletId` in
`send-lightning.ts`, which is the upstream-galoy LND rail and is dormant on
this deployment. On this rail the IBEX account id is the Flash wallet id.

**Order first, vendor second, payment third.** `purchaseGiftCard` writes the
`CREATED` row before calling `provider.createOrder`, and calls the vendor
before paying. A crash at any point leaves a row the reconcile worker can
reason about; a vendor order with no Flash row cannot exist.

**Money moves at most once per order.** Two layers:

- The order row is unique on `(walletId, idempotencyKey)`; a replay with the
  same key and parameters returns the existing order without reaching the
  vendor, and the same key with different parameters is
  `GiftCardIdempotencyKeyReuseError`.
- The Lightning send runs under `withPaymentIdempotency` with key
  `giftcard:<orderId>` and fingerprint `ln|<paymentRequest>|giftcard|<orderId>`,
  so a different order can never replay a previous success. The cached result
  lives at `payment-idempotency:<walletId>:giftcard:<orderId>`
  (`src/app/payments/idempotency.ts`).

**Quote tolerance.** The invoice Flash is about to pay is decoded and
`max(decodedSats, vendorStatedSats)` must be `<= quoteSats * (1 + toleranceBps/10000)`.
`GiftCardsConfig.quoteToleranceBps` wins over the domain constant
`GIFT_CARD_QUOTE_TOLERANCE_BPS` (both default 100). Over tolerance: `FAILED`,
nothing paid.

**Claim data is ciphertext at rest.** `encryptGiftCardClaim` produces
AES-256-GCM, base64 of `version(0x01) | iv(12) | tag(16) | data`, with a fresh
iv per call. `claimKeyId` (first 16 hex chars of sha256 of the raw key bytes)
is stored next to each ciphertext; a mismatch on read is reported as
`GiftCardClaimCryptoError`, never guessed around. Plaintext exists only inside
`settle-order.ts` (in) and `get-order.ts` (out); it is never logged, traced,
or put in an ops event, `toJSON` on the schema drops `claimCiphertext`, and the
GraphQL source object (`toGiftCardOrderSource`) has no ciphertext field at all.

**Catalog is served from Redis only.** No request path calls
`listProducts`. Between `catalog.ttlSeconds` and `catalog.staleAfterSeconds`
the catalog is served with `stale: true`; past `staleAfterSeconds` Redis drops
the key and reads become `GiftCardCatalogUnavailableError`.

**`feeBps` is not applied anywhere.** The config key exists and defaults to 0;
no code path reads it. Revenue today is the vendor reward only.

## Redis key inventory

| Key | Value | TTL | Writer |
| --- | --- | --- | --- |
| `giftcards:catalog:<providerId>:<CC>` | `{ syncedAt, products[] }` | `catalog.staleAfterSeconds` | `GiftCardCatalogCache.write` |
| `giftcards:catalog:<providerId>:countries` | `string[]` (written last) | `catalog.staleAfterSeconds` | same |
| `giftcards:product:<productId>` | `GiftCardProduct` | `catalog.staleAfterSeconds` | same |
| `giftcards:catalog-sync:lock` | token | 10 min, `NX` | `syncGiftCardCatalogs` |
| `giftcards:catalog-sync:last-run` | ISO timestamp | `catalog.syncIntervalSeconds`, `NX` | same (throttle marker) |
| `giftcards:reconcile:lock` | token | 5 min, `NX` | `reconcileGiftCardOrders` |
| `giftcards:auth:bitcoinCompany` | `{ accessToken, refreshToken, accessExpiresAt }` | 21 days | TBC client (`RedisTokenStore`) |
| `giftcards:auth:bitcoinCompany:lock` | nonce | 10 s, `NX` | same |
| `giftcards:reservation:<accountId>:<id>` | amount (minor) | 24 h | `reservation-store.ts` |
| `giftcards:reservations:<accountId>` | zset, score = expiry ms, member `<amount>:<id>` | pruned by score on read | same |
| `payment-idempotency:<walletId>:giftcard:<orderId>` | cached send result | see `idempotency.ts` | `withPaymentIdempotency` |
| rate-limiter bucket, prefix `gift_card_purchase` | per `accountId` | 60 s window, 300 s block | `consumeLimiter` (`RateLimitConfig.giftCardPurchase`) |

Every module that touches Redis imports `@services/redis` lazily so unit tests
never open a connection.

## Mongo: `giftcardorders`

One document per purchase attempt; fields as in `GiftCardOrder`
(`index.types.d.ts`). Indexes, identical in `GiftCardOrderSchema` and the
migration so `syncIndexes()` on boot has nothing to rebuild:

| Name | Keys | Options | Purpose |
| --- | --- | --- | --- |
| `id_1` | `{ id: 1 }` | unique | Our UUID, the only id the API shows |
| `accountId_1_createdAt_-1` | `{ accountId: 1, createdAt: -1 }` | | Account history, keyset paging |
| `providerId_1_providerOrderId_1` | `{ providerId: 1, providerOrderId: 1 }` | unique, partial `{ providerOrderId: { $type: "string" } }` | One vendor order maps to one Flash order; partial (not sparse) so two orders still awaiting a vendor id do not collide |
| `status_1_updatedAt_1` | `{ status: 1, updatedAt: 1 }` | | Reconciler sweep, stalest first |
| `walletId_1_idempotencyKey_1` | `{ walletId: 1, idempotencyKey: 1 }` | unique | Client retry / concurrent same-key purchase yields one order |

The E11000 on `walletId_1_idempotencyKey_1` is mapped to
`GiftCardOrderDuplicateKeyError`; any other duplicate stays a generic
`DuplicateKeyForPersistError` because it is a bug.

## Jobs

| Job | Where | Cadence | Guard |
| --- | --- | --- | --- |
| Catalog sync | `cron.ts` `syncGiftCardCatalogsJob` | every cron run, throttled to `catalog.syncIntervalSeconds` by the Redis marker | `giftCards.enabled`; distributed lock |
| Reconcile | `trigger.ts` `startGiftCardReconcileInterval` (30 s) and `cron.ts` `reconcileGiftCardOrdersJob` | 30 s in the trigger pod; cron as safety net | any non-terminal order exists (`hasOpenGiftCardOrders`, one `limit: 1` read) — **not** `giftCards.enabled`, so the kill switch never strands a paid order; shared Redis lock |

Reconcile PAID backoff: 5s, 15s, 60s, 5m, then every 15m from the PAID
transition. Attempt timing is process memory, so the cron (a fresh process)
polls each PAID order once per run and the trigger interval carries the real
schedule. Stuck-order horizons: PAID for 24h becomes `REFUND_REQUIRED`;
PAYMENT_PENDING with no resolvable IBEX status logs a warning after 60 min and
stays put.
