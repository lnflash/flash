# Gift Card Alerting

Two signals: the **ops-event feed** (Discord embeds, flow `giftcard`,
`src/services/alerts/ops-events.ts`) for the funnel and for humans, and
**tracing** (span attributes and recorded exceptions) for counting and paging.
The feed is fire-and-forget, does nothing when `OPS_DISCORD_WEBHOOK_URL` is
unset, and drops its oldest entries on overflow (50-deep queue), so alert
rules belong on traces, not on Discord.

Nothing gift-card-related goes through the Bridge `AlertService`
(`docs/bridge-integration/ALERTING.md`); there is no PagerDuty wiring yet.
"Page" below means "should be wired to page".

## Ops events

Embed title is `🎁 Giftcard — <phase with dashes as spaces>`; colour follows
`status` (green success, amber pending, red failed). Every order-shaped event
(`notifyGiftCardOpsEvent`, `src/app/gift-cards/ops.ts`) carries `account`,
`amount` (display units, e.g. `25.00 USD`), `orderId`, `providerId`,
`productId`, `env`, plus the phase's own `meta`. Claim data is never in an
event by construction: the helper takes an order, not a claim.

| Phase | Status | Emitted by | Meaning | Action |
| --- | --- | --- | --- | --- |
| `order-created` | pending | `purchaseGiftCard` | Row written, vendor not yet called | none |
| `payment-pending` | pending | `purchaseGiftCard` | IBEX reported the send in flight, **or** returned a 200 naming no recognised status (`paymentSendStatusOrPending` converts it to Pending) — both `meta.reason` `payment-pending`; or the send errored without a verdict — socket reset, gateway 5xx, timeout after the request was accepted (`meta.reason` `payment-unconfirmed: <Error>`, `error` naming the class) | none; worker resolves against IBEX, then the vendor. Warn if the same order is still pending after 60 min (see log line below). A burst of `payment-unconfirmed` is an IBEX connectivity problem |
| `order-paid` | success | `purchaseGiftCard`, `settleOrderFromVendor`, reconcile `settleAsPaid` | Payment settled; awaiting the card. `statusHistory` reason is `payment-settled`, `vendor-reported-fulfilled`, `payment-settled-on-reconcile` or `payment-settled-after-expiry` (a late Success on an EXPIRED row) | none |
| `order-fulfilled` | success | `settleOrderFromVendor` | Claim stored; push sent | none |
| `order-failed` | failed | `purchaseGiftCard`, `settleOrderFromVendor`, reconcile | Refused or expired **before** payment. `meta.reason`: `vendor-create-failed: <Error>`, `vendor-invoice-undecodable`, `quote-mismatch: ...`, `payment-error: <Error>` (only for a send IBEX provably refused), `payment-failed`, `expired`, `payment-unresolved-expired` (pending with no IBEX ref, vendor says unpaid, 24 h past `expiresAt`). For a vendor cancel before payment the event's `error` is `vendor-failed` / `vendor-refunded` and `meta.reason` the raw vendor status; `vendor-failed: <status>` is the `statusHistory` reason | Warn on rate. A burst of `quote-mismatch` means the vendor's pricing moved faster than tolerance; a burst of `vendor-create-failed` means the vendor is rejecting or down |
| `paid-not-recorded` | failed | `purchaseGiftCard` | IBEX reported Success but the `PAID` write failed (lost race or store fault). The order is still returned to the client; until the worker or an operator records it, the row shows unpaid for money that has left the wallet. `meta.providerPaymentRef` is the IBEX transaction id | **Page.** RUNBOOK (i) |
| `refund-required` | failed | `settleOrderFromVendor`, reconcile `processPaid` | **Money left Flash and no card came.** `error` is `vendor-failed`, `vendor-refunded`, or `fulfillment-timeout` (24 h in PAID and the final vendor poll **positively** reported not fulfilled; `meta.lastVendorPoll` is `not-fulfilled`; a vendor error does not escalate) | **Page.** RUNBOOK (a). Every occurrence is a customer owed money |
| `claim-encrypt-failed` | failed | `settleOrderFromVendor` | Card issued at the vendor; Flash could not encrypt the claim (key missing/invalid). Order stays `PAID` | **Page.** Fix `claimDataEncryptionKey`; the next poll retries |
| `vendor-fulfilled-unexpected` | failed | `settleOrderFromVendor` | Vendor says fulfilled but our order is terminal-unpaid (`meta.orderStatus`). Someone paid; our records say not us | **Page.** Reconcile by hand |
| `would-reject` | pending | `authorizeGiftCardPurchase` (log-only) | A limits check would have refused; `meta.reason`, `meta.level`, `meta.productId`, `error` | Review weekly before flipping to enforce (RUNBOOK f). `reason: limits-unavailable` must be zero |
| `rejected` | failed | `authorizeGiftCardPurchase` (enforce) | A limits check refused | Warn on rate; investigate `limits-unavailable` immediately |
| `catalog-synced` | success | `syncGiftCardCatalogForProvider` | `meta.products`, `meta.countries`, `meta.durationMs` | none. Absence for > `syncIntervalSeconds` x 2 is the signal |
| `catalog-sync-failed` | failed | `syncGiftCardCatalogForProvider` | Vendor pull or Redis write failed for one provider, **or the pull received zero rows / kept none after mapping** (a failure, not an empty catalog: the previous one keeps serving) (`error`, `meta.providerId`) | Warn. Two consecutive failures: RUNBOOK (g) |
| `catalog-stale` | pending | `listGiftCardProducts` | A request was served a catalog older than `catalog.ttlSeconds`. Coalesced to one per provider per 10 min | Warn. The catalog will vanish at `staleAfterSeconds` |

`would-reject` and `rejected` are not coalesced; they are bounded by the
caller's attempt budget. `catalog-stale` is coalesced
(`GIFT_CARD_STALE_EVENT_COALESCE_MS`).

## What should page vs warn

| Page (someone acts within the hour) | Warn (review same day) |
| --- | --- |
| `refund-required` (any) | `catalog-stale`, `catalog-sync-failed` |
| `paid-not-recorded` (any) | `order-failed` rate above baseline |
| `claim-encrypt-failed`, `vendor-fulfilled-unexpected` | vendor 5xx / network: span exceptions `BitcoinCompanyApiError` (>= 500) and `BitcoinCompanyNetworkError` (Warn) |
| TBC auth failure: span exception `BitcoinCompanyAuthError` (Critical) | An order in `PAID` longer than 15 min (RUNBOOK b) |
| `BitcoinCompanyResponseShapeError` (Critical): the vendor changed its API | An order in `PAYMENT_PENDING` longer than 60 min (log line below; RUNBOOK c) |
| `limits-unavailable` in enforce mode (`UnknownGiftCardError`, Critical) | `would-reject` volume while in log-only |
| `GiftCardClaimCryptoError` at Critical from `giftCardOrder` (a FULFILLED order nobody can read; `giftcard.claimKeyId` on the span) | |

Suggested thresholds, to tune once there is traffic:

- `refund-required` or `paid-not-recorded`: >= 1 in 5 min pages.
- `BitcoinCompanyAuthError`: >= 1 pages (every purchase and poll fails until fixed).
- Vendor 5xx/network (`giftcard.provider = bitcoinCompany`, exception level Warn): > 5 in 5 min warns, > 20 in 5 min pages.
- `order-failed` with `meta.reason` starting `quote-mismatch`: > 3 in 15 min warns (tolerance too tight or vendor volatility).
- `catalog-synced` absent for 2 x `syncIntervalSeconds` (12 h at defaults) warns; `catalog-stale` firing at all warns.
- Reconcile summary `refundRequired > 0` warns. `scanned` sums three listings of up to 200 each (open, pending, paid); a run at 600 means every batch cap was hit and orders are being left for the next tick.

## Log lines worth a rule

All from `baseLogger` with `module: "gift-cards.reconcile"` unless noted:

| Level | Message | Meaning |
| --- | --- | --- |
| warn | `Gift card payment has been pending for over an hour with no resolvable status` | PAYMENT_PENDING with no `providerPaymentRef` or an IBEX lookup that never resolves, AND the vendor does not report fulfilled; carries `orderId`, `paymentHash`, `providerPaymentRef`. Self-terminates as `payment-unresolved-expired` 24 h past `expiresAt` when the vendor reports unpaid |
| warn | `Gift card payment outcome unknown after send error; holding as PAYMENT_PENDING` (purchase) | The send errored without proving IBEX refused it; carries `orderId`, `providerPaymentRef`, `error`. The worker settles it |
| warn | final vendor poll at the 24 h horizon failed (reconcile) | The vendor could not be reached at the fulfilment timeout; the order stays `PAID` and is polled again next run. It does **not** escalate |
| error | `Gift card reconcile failed for order` | One order threw; the batch continued |
| error | `Gift card payment settled but PAID transition failed` (purchase) | Money moved, bookkeeping lost a race or the store faulted; pairs with the `paid-not-recorded` event (RUNBOOK i) |
| error | `Gift card claim could not be read for a FULFILLED order` (`giftCardOrder` resolver) | Key missing/rotated or ciphertext bound to another order; carries `orderId`, `claimKeyId`, never the ciphertext |
| warn | `Bitcoin Company reported "<status>" without claim data; holding as pending` (adapter) | Vendor said done with nothing to redeem; polling continues |
| warn | `Bitcoin Company returned unknown order status "<status>"; holding as pending` | New vendor status; add it to `VENDOR_STATUS_TABLE` |
| warn | `Bitcoin Company reported "<status>"; holding as pending until the vendor settles it or the timeout decides` | A `disputed` order: held, never refunded on the vendor's word alone; the 24 h timeout or TBC decides |

The trigger-pod tick logs **nothing** on a successful or lock-held run; only
`gift card reconcile tick failed` / `gift card reconcile tick threw`. The cron
run logs `gift card reconcile finished` with the summary.

## Span attributes

Every attribute is a string unless noted. Namespaces:
`services.gift-cards.bitcoin-company` (adapter), `services.gift-cards.catalog-cache`,
`app.gift-cards` (`syncGiftCardCatalogs`, `listGiftCardProducts`, `getGiftCardProduct`);
the other use cases are wrapped by `src/app/index.ts` like every `@app` export,
and the jobs run under `cron.<taskName>`.

| Attribute | Set by | Values |
| --- | --- | --- |
| `giftcard.provider` | adapter, client, purchase, quote, settle | `bitcoinCompany` |
| `giftcard.op` | client (`call` pipeline only) | `listProducts`, `quote`, `createOrder`, `getOrder`. `login` and `refreshToken` bypass `call` and do **not** set it |
| `giftcard.productId`, `giftcard.valueMinor` (number), `giftcard.quantity` (number) | purchase, quote | request args |
| `giftcard.orderId` | purchase, settle, get-order, `giftCardOrder` resolver | our UUID |
| `giftcard.replay` | purchase | `true` when an existing order was returned for the key |
| `giftcard.replay.resumedPayment` | purchase | `true` when the replay re-entered the pay step on an unpaid INVOICE_ISSUED order |
| `giftcard.quoteSats`, `giftcard.invoiceSats` (numbers) | purchase | the tolerance comparison inputs |
| `giftcard.providerPaymentRef` | purchase | IBEX `transaction.id`, or `""` |
| `giftcard.status` | settle, get-order | order status before the settle / at read |
| `giftcard.vendorStatus` | settle | `awaitingPayment`, `paidPendingFulfillment`, `fulfilled`, `failed`, `refunded` |
| `giftcard.claimKeyId` | `giftCardOrder` resolver, on a claim read failure | the key id stored on the order (a fingerprint, never key bytes) |
| `giftcard.limits.mode`, `giftcard.limits.reason`, `giftcard.limits.error` | authorize (on any would-reject/reject) | mode; `level-not-eligible`, `account-too-new`, `per-card-cap`, `daily-cap`, `vendor-daily-cap`, `vendor-card-cap`, `velocity`, `open-loop-not-allowed`, `limits-unavailable`; error class name |
| `giftcard.country.source`, `giftcard.country.candidates` (number) | master gate | phone-country resolution |
| `giftcard.reconcile.skipped` | reconcile | `lock-held` |
| `giftcard.reconcile.scanned/fulfilled/refundRequired/expired/paymentSettled` (numbers) | reconcile | per-run summary |

Count limits outcomes from `giftcard.limits.reason`, not from Discord, for the
same reason `docs/send-guard.md` counts from `sendGuard.rejection`.

Recorded exceptions (`recordExceptionInCurrentSpan`) and their levels:
`BitcoinCompanyApiError` Warn, `BitcoinCompanyNetworkError` Warn,
`BitcoinCompanyUnauthorizedError` Warn, `BitcoinCompanyResponseShapeError`
Critical, `BitcoinCompanyAuthError` Critical, unexpected client throw
Critical; settle-order records `GiftCardOrderStateError` (vendor fulfilled on a
terminal order) and `GiftCardClaimCryptoError` (Critical); the `giftCardOrder`
resolver records `GiftCardClaimCryptoError` at Critical; purchase records the
INVOICE_ISSUED and PAID transition failures; reconcile records every per-order
throw.
