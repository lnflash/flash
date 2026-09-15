# Gift Cards Testing

## Unit suites

`yarn test:unit` sources `./.env` and runs jest with
`test/flash/unit/jest.config.js`; `TEST` narrows the path. No Mongo, no Redis:
every gift card module imports `@services/redis` lazily and the specs mock
`@config`, `@services/mongoose`, `@services/redis`, `@services/tracing` and
the logger.

```bash
TEST=test/flash/unit/app/gift-cards yarn test:unit
TEST=test/flash/unit/services/gift-cards yarn test:unit
TEST=test/flash/unit/services/mongoose/gift-card-orders yarn test:unit
TEST=test/flash/unit/domain/gift-cards yarn test:unit
TEST="test/flash/unit/graphql/public test/flash/unit/config/rate-limits.spec.ts" yarn test:unit
TEST=test/flash/unit/app/payments/pay-invoice-via-ibex.spec.ts yarn test:unit
```

| Spec | Covers |
| --- | --- |
| `test/flash/unit/app/gift-cards/purchase-gift-card.spec.ts` | Happy path to FULFILLED on the first poll; PAID returned when the poll is pending or errors; `providerPaymentRef` captured on PAID / PAYMENT_PENDING / PAYMENT_FAILED and null on replay; idempotent replay (before the attempt budget, no point spent, no gate), key reuse refusal, unique-index race; replay of an unpaid INVOICE_ISSUED order resumes the pay step (busy lock returns the row unchanged; not resumed while expired, while the kill switch is off, or for CREATED / PAYMENT_PENDING); every refusal before a row exists (rate limit, wallet ownership, gate, claim key not configured, routing, product country vs account country, value, `wholeUnitsOnly`, quantity and `maxQuantity`, limits); vendor reject (fixed customer message) / 5xx / undecodable invoice / tolerance boundary; order expiry = min(TTL, decoded BOLT11, vendor-stated); send errors that prove refusal -> PAYMENT_FAILED vs. unknown outcome -> PAYMENT_PENDING (ref kept when IBEX answered; concurrent attempt wins); after IBEX answers the order is always returned — lost PAID write -> `paid-not-recorded` Critical event, late Success on EXPIRED -> PAID; claim never in ops events or logs |
| `authorize-purchase.spec.ts` | Levels x amounts x modes table; account age; open-loop switch and level floor; velocity; daily cap including REFUND_REQUIRED and live Redis holds; vendor caps; reservations write/release; `limits-unavailable` in each mode; would-reject / rejected event shape |
| `quote-gift-card.spec.ts` | Quote attempt budget charged first (refusal, store-fault fall-through, refused attempts count); gate on the account's country; product lookup, provider routing and out-of-stock refusals; value (min/max/off-denomination/non-integer) and quantity validation; disabled-provider refusal; vendor quote failure pass-through |
| `get-order.spec.ts` | NotFound for unknown id and for another account's order (indistinguishable, never decrypts); repository fault pass-through; no decrypt before FULFILLED or without ciphertext; decrypt under the stored key id for the order; decrypt failure returned as DATA (`claimError`) with the order; span carries id and status, never ciphertext or claim |
| `list-orders.spec.ts` | Owner-scoped listing, newest first; keyset paging on `createdAt`; `first` defaults and caps; repository errors |
| `settle-order.spec.ts` | PAID -> FULFILLED with encrypted claim, event and push; idempotent on FULFILLED; vendor-first payment (PAYMENT_PENDING / INVOICE_ISSUED -> PAID -> FULFILLED); terminal-unpaid + vendor fulfilled pages; encryption failure leaves PAID; losing the FULFILLED race; failed/refunded on PAID -> REFUND_REQUIRED, on INVOICE_ISSUED -> FAILED, on PAYMENT_PENDING left alone; `fetchAndSettle` resolves the provider by registration (not `enabled`) and guards |
| `reconcile-orders.spec.ts` | Poll schedule (`nextGiftCardPollAt`); lock acquire/release/foreign token; expiry: CREATED expires outright, INVOICE_ISSUED gets one vendor poll (fulfilled -> FULFILLED, not paid or vendor error -> EXPIRED), no IBEX re-read; PAYMENT_PENDING settled/failed/in-flight (no vendor poll), unknown and no-ref (vendor poll; fulfilled -> FULFILLED, vendor error -> stays pending, vendor unpaid 24 h past `expiresAt` -> PAYMENT_FAILED `payment-unresolved-expired`), IBEX error, unconfirmed; PAID backoff and fresh-process behaviour; 24 h escalation only on a positive not-fulfilled (fulfilled -> FULFILLED, vendor refund -> once, vendor error -> stays PAID and retries); per-order isolation; `hasOpenGiftCardOrders`; job and interval run while `giftCards.enabled` is false and skip the lock with nothing open; error propagation |
| `sync-catalog.spec.ts` | Per-provider write and counts; vendor failure, adapter throw, cache write failure, an empty catalog (received zero or kept none) is a failure; multi-provider isolation; lock TTL and ownership; Redis-down and registry-throw safety; interval marker claim/skip/release |
| `list-products.spec.ts` | Stock and open-loop filters; category/search; ordering; cursor paging without gaps or repeats; unknown cursor restart; `first` defaults and caps; routing and cache errors; stale-catalog event coalescing; `getGiftCardProduct` |
| `gift-cards-master-gate.spec.ts` | Rail off, provider disabled or unregistered, case-insensitive routing (keys and lookup), country routed to a disabled provider, unknown-country sentinel; phone-country resolution (single, ambiguous, none, user load failure, never throws) |
| `test/flash/unit/domain/gift-cards/primitives.spec.ts` | `checkedGiftCardValue` (fixed / variable / `wholeUnitsOnly` / non-integer) and `checkedGiftCardQuantity` (1..`min(maxQuantity, 10)`; a vendor cap below 1 reads as 1) |
| `test/flash/unit/services/gift-cards/bitcoin-company/client.spec.ts` | Login/cache/refresh/401-retry/fallback-to-login/credentials-missing/lock serialisation/Redis-down; catalog paging (500 + short page), received/kept/skipped/flagged counts, GET retries and 4xx no-retry; purchase never retried, 4xx-with-message -> rejected, envelope-with-null-result; quote 4xx -> `GiftCardInvalidValueError`; invoice-status retries; numeric-string coercion; timeout applied; log hygiene (`redactForLog`); `giftcard.op` set only on the `call` pipeline |
| `bitcoin-company/mapping.spec.ts` | Unit conversion; product mapping (fixed/variable/VariableNoCents -> `wholeUnitsOnly`, `maxQuantity` 1, dedupe, country, currency, logo, terms, categories); `stripBrand`; quote/purchase/claim mapping (purchase `expiresAt` is null, never fabricated); full vendor status table, case-insensitivity, `disputed` and unknown statuses held as pending |
| `registry.spec.ts` | `getRegisteredGiftCardProviderOrError` returns the adapter while the master or provider switch is off and errors only when unregistered; `getEnabledGiftCardProvider` refuses on either switch; byCountry/default routing requires the result to be registered and enabled; `byCountry` key normalisation |
| `bitcoin-company/contract.spec.ts` | Runs `runGiftCardProviderContract` (`test/flash/unit/services/gift-cards/provider-contract.ts`, the shared port contract every adapter must pass) plus TBC-specific assertions and registration idempotency |
| `catalog-cache.spec.ts` | Per-country grouping, per-product keys, countries index written last, de-listed product keys deleted on the next sync, legacy rows default `maxQuantity` 1 / `wholeUnitsOnly` false, `staleAfterSeconds` retention, write failure short-circuits, fresh/stale boundary, normalisation, missing/unreadable/garbage records |
| `claim-crypto.spec.ts` | Round trip, envelope layout, fresh iv per call, tamper detection on payload/tag/iv, version and length checks, key id, key rotation mismatch, hex/base64/whitespace/wrong-length key loading; AAD binding — a ciphertext decrypts only under the key id and order id it was sealed for (transplant to another order fails) |
| `test/flash/unit/services/mongoose/gift-card-orders.spec.ts`, `.mapping.spec.ts`, `.schema.spec.ts` | Repository create/find/list/transition against a mocked model (the exact `findOneAndUpdate` issued); record -> domain mapping; transition table derived from the domain (including `EXPIRED -> PAID`); duplicate-key attribution; the five indexes match the migration; `toJSON` drops `claimCiphertext`; status enum enforced |
| `test/flash/unit/graphql/public/root/mutation/gift-card-purchase.spec.ts` | Scalar and `idempotencyKey` validation before any purchase; no resolver-level gate (a same-key replay while the rail is off returns the order; a fresh purchase relays the app layer's `GIFT_CARDS_DISABLED`); arguments passed through unchanged, quantity default; limiter not consumed here; every pre-payment error mapped to its code; post-IBEX PAID / PAYMENT_PENDING orders carried with `claim: null` and empty `errors`; claim attached via the owner-scoped read when already FULFILLED; decrypt failure and read failure ride alongside the order; ciphertext never on the payload |
| `root/query/gift-card-catalog.spec.ts` | Gate thrown (rail off, provider unavailable); account vs explicit country for gate and list; scalar error for a malformed code; filters and paging passed through; relay edges with the app's cursor codec; empty connection; mapped catalog errors |
| `root/query/gift-card-quote.spec.ts` | Scalar and quantity validation before the gate; gate thrown; quote for THIS account in minor units; wire mapping drops the vendor price; `expiresAt` as a Date; mapped refusals; declared complexity budget |
| `root/query/gift-card-order.spec.ts` | Reads while the rail is off; owner scoping; null for unknown and foreign ids alike; repository fault thrown; FULFILLED with unreadable claim still returned with `claim: null`, recorded at Critical, ciphertext never on span/log/wire; claim only when FULFILLED; wire field mapping |
| `root/query/gift-card-orders.spec.ts` | Cursor codec round-trip and garbage rejection; reads while the rail is off; owner scoping; page-size and cursor argument refusals; relay edges with `createdAt` cursors; claim never in a listing; empty connection; store errors |
| `root/query/globals-gift-cards.spec.ts` | `giftCardsEnabled` true only with the rail on and any provider enabled |
| `types/object/gift-card-order.spec.ts` | Status and denomination enums mirror the domain; `toGiftCardOrderSource` exposes only public fields and attaches the claim only when FULFILLED; the GraphQL types declare no ciphertext-bearing field; every field described; connection names |
| `test/flash/unit/config/rate-limits.spec.ts` | Purchase (10/60 s/300 s) and quote (30/60 s/300 s) attempt budgets pinned literally, wired under their own prefixes and errors |
| `test/flash/unit/app/payments/pay-invoice-via-ibex.spec.ts` | Pays from the wallet's IBEX account; Success/Pending/unrecognised mapping; `IbexError` pass-through; `onResponse` gets the raw 200 and never runs on a guard rejection or replay; the idempotency wrapper receives key, fingerprint and guard unchanged |

Shared fixtures: `test/flash/unit/app/gift-cards/fixtures.ts`
(`makeGiftCardsConfig`, `makeLimitsConfig`, order/product builders) and
`test/flash/unit/services/gift-cards/bitcoin-company/fixtures.ts` (vendor
response shapes, `BASE_URL`). Note the unit fixture's `perLevel` values differ
from `base-config.yaml`; specs assert against the fixture.

## Integration spec (real Mongo)

`test/flash/integration/gift-cards/gift-card-orders.spec.ts` runs the
repository against a live collection because index and race behaviour cannot
be asserted on a mock:

- two racing `transition`s from the same state: exactly one wins, the other
  gets `GiftCardOrderStateError`;
- `{ walletId, idempotencyKey }` unique -> `GiftCardOrderDuplicateKeyError`;
- `{ providerId, providerOrderId }` is **partial** unique: two orders with
  `providerOrderId: null` both insert (a sparse index would fail this);
- `toJSON` drops `claimCiphertext`.

It calls `GiftCardOrders.syncIndexes()` in `beforeAll` so it never silently
tests an index-less collection. What it needs: the integration harness
(`test/flash/integration/jest.setup.ts`) with `MONGODB_CON` and Redis reachable
and IBEX mocked; locally `make integration` (`reset-deps-integration` brings
the containers up) or directly:

```bash
TEST=test/flash/integration/gift-cards yarn test:integration
```

It lives under `test/flash/integration/gift-cards` because the integration
jest config ignores `test/flash/integration/services/*`.

Migration behaviour (idempotent create, drop-and-recreate on spec drift,
`down` drops by name and keeps documents) is exercised by the CI migrate job
(`make test-migrate`), not by a dedicated spec.

## Planned sandbox e2e (not yet on disk)

Mirrors `test/flash/bridge-sandbox-e2e/` (opt-in via
`RUN_BRIDGE_SANDBOX_E2E`; `README.md` there describes the pattern): a
`test/flash/giftcard-sandbox-e2e/` suite gated on `RUN_GIFTCARD_SANDBOX_E2E=true`
that runs the real purchase path against TBC's sandbox
(`https://api.dev.thebitcoincompany.com`, Mutinynet).

What it needs, per the TBC wiki:

- TBC sandbox credentials in `.env.local` / `dev-overrides.yaml`
  (`giftCards.providers.bitcoinCompany.email` / `password`), never committed.
- A Mutinynet Lightning wallet to pay sandbox invoices: a Voltage node on
  Mutinynet funded from the Mutinynet faucet. The IBEX rail cannot pay
  Mutinynet invoices, so the e2e either pays the bolt11 from that node in
  place of `payLnInvoiceViaIbex` (mock the rail, pay out of band, then let the
  worker settle) or asserts only up to `INVOICE_ISSUED`.
- `giftCards.enabled: true`, `providers.bitcoinCompany.enabled: true`, a
  throwaway `claimDataEncryptionKey`, `limits.mode: off` for the test account.

Suggested cases: catalog sync writes real products; quote for a fixed and a
variable card; purchase reaches `INVOICE_ISSUED` with a decodable Mutinynet
invoice within tolerance; after out-of-band payment the worker moves the order
to `FULFILLED` and `giftCardOrder` returns a claim for the owner and null for
another account; a second purchase with the same key replays.

## Not yet covered

- `send-fulfilled-notification.ts` and `ops.ts` have no direct spec; they are
  exercised through the purchase and settle specs.
- The end-to-end Lightning payment: `payLnInvoiceViaIbex` is mocked in every
  suite, the integration harness mocks `@services/ibex/client`, and the
  sandbox e2e above does not exist yet.
- `src/servers/cron.ts` / `trigger.ts` wiring of the two jobs.
- The registry's routing with two registered providers (only one adapter
  exists).
- Claim key rotation / re-encryption: the crypto spec proves the mismatch is
  detected; there is no migration and no test for one.
- The GraphQL schema itself is exercised only by the resolver specs above
  (no executable-schema query test); the generated SDL is the contract check.
