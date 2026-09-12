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
TEST=test/flash/unit/app/payments/pay-invoice-via-ibex.spec.ts yarn test:unit
```

| Spec | Covers |
| --- | --- |
| `test/flash/unit/app/gift-cards/purchase-gift-card.spec.ts` | Happy path to FULFILLED on the first poll; PAID returned when the poll is pending or errors; `providerPaymentRef` captured on PAID / PAYMENT_PENDING / PAYMENT_FAILED and null on replay; idempotent replay, key reuse refusal, unique-index race; replay of an unpaid INVOICE_ISSUED order resumes the pay step (and does not while expired, while the kill switch is off, or for CREATED / PAYMENT_PENDING); every refusal before a row exists (rate limit, wallet ownership, gate, routing, value, quantity, limits); vendor reject / 5xx / undecodable invoice / tolerance boundary; order expiry = min(TTL, decoded BOLT11, vendor-stated); payment Failure; send errors that prove refusal -> PAYMENT_FAILED (InsufficientIbexBalance, FailedIbexPayment, idempotency-key errors, send-guard rejection) vs. unknown outcome -> PAYMENT_PENDING (generic IbexError, UnconfirmedIbexPayment, CompletedInvoice, busy lock; ref kept when IBEX answered; concurrent attempt wins); claim never in ops events or logs |
| `authorize-purchase.spec.ts` | Levels x amounts x modes table; account age; open-loop switch and level floor; velocity; daily cap including REFUND_REQUIRED and live Redis holds; vendor caps; reservations write/release; `limits-unavailable` in each mode; would-reject / rejected event shape |
| `settle-order.spec.ts` | PAID -> FULFILLED with encrypted claim, event and push; idempotent on FULFILLED; vendor-first payment (PAYMENT_PENDING / INVOICE_ISSUED -> PAID -> FULFILLED); terminal-unpaid + vendor fulfilled pages; encryption failure leaves PAID; losing the FULFILLED race; failed/refunded on PAID -> REFUND_REQUIRED, on INVOICE_ISSUED -> FAILED, on PAYMENT_PENDING left alone; `fetchAndSettle` resolves the provider by registration (not `enabled`) and guards |
| `reconcile-orders.spec.ts` | Poll schedule (`nextGiftCardPollAt`); lock acquire/release/foreign token; expiry with and without a settled or in-flight payment, vendor fallback for a no-ref INVOICE_ISSUED (fulfilled -> FULFILLED, nothing -> EXPIRED, IBEX FAILED -> no poll); PAYMENT_PENDING settled/failed/in-flight (no vendor poll), unknown and no-ref (vendor poll; fulfilled -> FULFILLED, vendor error -> stays pending), IBEX error, unconfirmed; PAID backoff and fresh-process behaviour; 24 h escalation only after a final vendor poll (fulfilled -> FULFILLED, vendor refund -> once, vendor error -> escalate and name it); per-order isolation; `hasOpenGiftCardOrders`; job and interval run while `giftCards.enabled` is false and skip the lock with nothing open; error propagation |
| `sync-catalog.spec.ts` | Per-provider write and counts; vendor failure, adapter throw, cache write failure; multi-provider isolation; lock TTL and ownership; Redis-down and registry-throw safety; interval marker claim/skip/release |
| `list-products.spec.ts` | Stock and open-loop filters; category/search; ordering; cursor paging without gaps or repeats; unknown cursor restart; `first` defaults and caps; routing and cache errors; stale-catalog event coalescing; `getGiftCardProduct` |
| `gift-cards-master-gate.spec.ts` | Rail off, provider disabled, case-insensitive routing, country routed to a disabled provider, unknown-country sentinel; phone-country resolution (single, ambiguous, none, user load failure, never throws) |
| `test/flash/unit/services/gift-cards/bitcoin-company/client.spec.ts` | Login/cache/refresh/401-retry/fallback-to-login/credentials-missing/lock serialisation/Redis-down; catalog paging (500 + short page), row skipping, GET retries and 4xx no-retry; purchase never retried, 4xx-with-message -> rejected, envelope-with-null-result; invoice-status retries; numeric-string coercion; timeout applied; log hygiene (`redactForLog`) |
| `bitcoin-company/mapping.spec.ts` | Unit conversion; product mapping (fixed/variable/VariableNoCents, dedupe, country, currency, logo, terms, categories); `stripBrand`; quote/purchase/claim mapping (purchase `expiresAt` is null, never fabricated); full vendor status table, case-insensitivity, unknown status held as pending |
| `registry.spec.ts` | `getRegisteredGiftCardProviderOrError` returns the adapter while the master or provider switch is off and errors only when unregistered; `getEnabledGiftCardProvider` refuses on either switch; byCountry/default routing to a disabled provider is unavailable |
| `bitcoin-company/contract.spec.ts` | Runs `runGiftCardProviderContract` (`test/flash/unit/services/gift-cards/provider-contract.ts`, the shared port contract every adapter must pass) plus TBC-specific assertions and registration idempotency |
| `catalog-cache.spec.ts` | Per-country grouping, per-product keys, countries index written last, `staleAfterSeconds` retention, write failure short-circuits, fresh/stale boundary, normalisation, missing/unreadable/garbage records |
| `claim-crypto.spec.ts` | Round trip, envelope layout, fresh iv per call, tamper detection on payload/tag/iv, version and length checks, key id, key rotation mismatch, hex/base64/whitespace/wrong-length key loading |
| `test/flash/unit/services/mongoose/gift-card-orders.spec.ts`, `.mapping.spec.ts`, `.schema.spec.ts` | Repository create/find/list/transition against a mocked model (the exact `findOneAndUpdate` issued); record -> domain mapping; transition table derived from the domain; duplicate-key attribution; the five indexes match the migration; `toJSON` drops `claimCiphertext`; status enum enforced |
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

- GraphQL resolver tests for `giftCardCatalog`, `giftCardQuote`,
  `giftCardOrder`, `giftCardOrders`, `giftCardPurchase` and
  `globals.giftCardsEnabled` (scalar validation, gate errors thrown vs returned,
  the claim-only-when-FULFILLED rule at the wire, cursor codecs).
- `quote-gift-card.ts`, `get-order.ts`, `list-orders.ts`,
  `send-fulfilled-notification.ts` and `ops.ts` have no direct spec; they are
  exercised indirectly through purchase and settle specs.
- The end-to-end Lightning payment: `payLnInvoiceViaIbex` is mocked in every
  suite, the integration harness mocks `@services/ibex/client`, and the
  sandbox e2e above does not exist yet.
- `src/servers/cron.ts` / `trigger.ts` wiring of the two jobs.
- The registry's routing with two registered providers (only one adapter
  exists).
- Claim key rotation / re-encryption: the crypto spec proves the mismatch is
  detected; there is no migration and no test for one.
