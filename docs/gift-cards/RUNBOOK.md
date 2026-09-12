# Gift Cards Runbook

Operator procedures. Mongo queries use the node + mongoose one-liner pattern
from `docs/bridge-integration/ENG-276-IMPLEMENTATION-RESUME.md` (no `mongosh`
in the repo); run them from a pod or jumpbox with `MONGODB_CON` set. Redis
commands assume `redis-cli` against the cluster's Redis (`make redis-cli`
locally). Config changes follow `docs/send-guard.md`: edit the values file,
`helm upgrade`, roll api, trigger **and** cron; the YAML is read once at start.

Helper used throughout (replace the query):

```bash
export Q='{"status":"REFUND_REQUIRED"}'
node -e "const m=require('mongoose');(async()=>{await m.connect(process.env.MONGODB_CON);const r=await m.connection.db.collection('giftcardorders').find(JSON.parse(process.env.Q),{projection:{_id:0,claimCiphertext:0,claimKeyId:0}}).sort({updatedAt:1}).limit(50).toArray();console.log(JSON.stringify(r,null,2));await m.disconnect();})().catch(async e=>{console.error(e);process.exit(1)})"
```

The projection **excludes** `claimCiphertext` and `claimKeyId`; never print
them, and never decrypt a claim outside `getGiftCardOrderForAccount`.

## (a) A `REFUND_REQUIRED` order

The only state meaning money left Flash and no card came. It pages
(`giftcard / refund-required`, ALERTING.md).

1. Find it. From the page, `meta.orderId`; or list them all:
   `Q='{"status":"REFUND_REQUIRED"}'`. Read `id`, `accountId`, `walletId`,
   `valueMinor`, `quantity`, `currency`, `paidSats`, `paymentHash`,
   `providerId`, `providerOrderId`, `paymentRequest`, `providerPaymentRef`
   (the IBEX transaction id), `failureReason`, and `statusHistory` (when PAID
   was written and why REFUND_REQUIRED followed: `vendor-failed: ...`,
   `vendor-refunded: ...`, or `fulfillment-timeout`).
2. Confirm our payment in the IBEX dashboard (or `Ibex.getTransactionDetails`
   with `providerPaymentRef`): the send for `paymentHash` settled. If IBEX
   shows it failed, the order should never have been PAID; note it and go on.
3. Confirm the vendor side (TBC). Log in with the same credentials as
   `giftCards.providers.bitcoinCompany` against the configured `baseUrl`, then:
   ```bash
   TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H 'content-type: application/json' \
     -d '{"email":"...","password":"..."}' | jq -r .result.accessToken)
   # status keyed by invoice, the same call the adapter makes
   curl -s -X POST "$BASE_URL/giftcards/invoice-status" -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' -d "{\"invoice\":\"$PAYMENT_REQUEST\"}" | jq '.result.status'
   # the account's orders, for the order labelled with our order id
   curl -s "$BASE_URL/user/giftcards" -H "authorization: Bearer $TOKEN" | jq '.result'
   ```
   Do not pipe the second response through anything that logs it: it may
   contain claim data. If TBC now reports a fulfilled card with claim data, the
   order was escalated on a timeout and the card exists: skip to 5b.
4. Chase the refund. Open a ticket with TBC support quoting our order id (their
   label), their order uuid (`providerOrderId`), the invoice and the paid
   amount. TBC refunds to the account balance or by Lightning; record which.
5. Record the outcome. There is no transition out of `REFUND_REQUIRED`
   (`GIFT_CARD_TRANSITIONS`), by design. Either **5a, refund received:** credit
   the wallet by the standard manual-credit support path, then `$set`
   `failureReason` to `"<existing>; refunded <date> <reference>"` (only that
   field) and reply to the page thread with the order id and credit reference.
   Or **5b, card actually issued:** engineering settles by hand with a one-off
   script that re-encrypts the claim onto the order (`fetchAndSettle` refuses a
   terminal order; `settleOrderFromVendor` on one pages
   `vendor-fulfilled-unexpected`); never paste claim codes anywhere.
6. Tell the customer. They must not be told to buy again; the app already
   shows the `REFUND_REQUIRED` copy.

## (b) Order stuck in `PAID` > 15 min

Normal fulfilment is seconds. The worker polls at 5s/15s/60s/5m then every
15m, and escalates to `REFUND_REQUIRED` only at 24 h and only when the vendor
positively reports not fulfilled (a vendor error keeps PAID and retries). A
PAID order older than 15 min is a vendor delay or a worker problem.

1. `Q='{"status":"PAID","updatedAt":{"$lt":{"$date":"<ISO 15 min ago>"}}}'`.
   Note the JSON date form; adjust the timestamp.
2. Is the worker running? The trigger tick logs **nothing** on a successful or
   lock-held run; look for `gift card reconcile tick failed` / `threw`
   (trigger) and `gift card reconcile finished` with its summary (cron). A
   cron summary of `skipped: lock-held` on every run means a run died holding
   the lock; it lapses after 5 min (`giftcards:reconcile:lock`). The worker
   runs regardless of `giftCards.enabled`; a tick only skips when no
   non-terminal order exists.
3. Check the vendor for that invoice (step (a)3). `unpaid`/`underpaid`/
   `confirming` while we show PAID means IBEX settled and TBC has not seen it:
   compare `paidSats` with the invoice amount and escalate to TBC. `pending` /
   `senttofulfillment` is a vendor delay: wait for the 15-minute poll.
   `completed` without `claimData`, and `disputed`, are held as pending by
   design (a dispute may still fulfil or refund); ask TBC.
4. Do not move the order by hand. If the vendor confirms the card will not
   come, the 24 h timeout writes `REFUND_REQUIRED`; to bring that forward,
   engineering runs `settleOrderFromVendor(order, { kind: "failed", reason })`.

## (c) Order stuck in `PAYMENT_PENDING` with no `providerPaymentRef`

The worker cannot re-read IBEX without the transaction id (no hash-based
fallback on this rail, `lookupSentPaymentStatus`), so every run it asks the
vendor instead (`fetchAndSettle`): a vendor `fulfilled` settles the order as
`PAID` then `FULFILLED` with no operator. An order still `PAYMENT_PENDING` after
60 min is therefore one the vendor shows unpaid (or cannot be reached for); the
worker logs `Gift card payment has been pending for over an hour with no
resolvable status` every run. Once `expiresAt` is 24 h past and the vendor
still reports unpaid, the worker closes it as `PAYMENT_FAILED`
(`payment-unresolved-expired`) on its own. The steps below are for that
window, or for an order the vendor cannot be reached for.

1. `Q='{"status":"PAYMENT_PENDING","providerPaymentRef":null}'`. Read
   `paymentHash`, `paymentRequest`, `walletId`, `invoiceSats`.
2. In the IBEX dashboard, find the outgoing payment on account `walletId` for
   `paymentHash`.
3. Settled or failed at IBEX: `$set` `providerPaymentRef` to the IBEX
   transaction id (only that field); the next run re-reads IBEX and writes
   `PAID` (then polls the vendor) or `PAYMENT_FAILED`. No IBEX record at all:
   the send never left; engineering transitions `PAYMENT_PENDING ->
   PAYMENT_FAILED` (reason `payment-failed`) via the repository, never by
   editing `status` (the `statusHistory` push matters for audits).

`PAYMENT_PENDING` **with** a ref for over an hour is an IBEX question (the
transaction exists but reports no recognised status); escalate with the id.

## (d) Disable the feature or one provider

One config change, then roll api + trigger + cron (not live-reloaded):

- Whole rail: `giftCards.enabled: false`. Catalog, quote and a fresh purchase
  return `GIFT_CARDS_DISABLED`, `globals.giftCardsEnabled` is false, catalog
  sync no-ops. **The reconcile worker keeps running** (trigger and cron) while
  any non-terminal order exists: in-flight orders settle, paid customers get
  their codes, the 24 h `REFUND_REQUIRED` alert fires. The switch stops new
  money leaving, nothing else: a same-key retry still returns its order (an
  unpaid `INVOICE_ISSUED` row as-is, not resumed; the worker expires it after a
  vendor poll). `giftCardOrder` / `giftCardOrders` keep working.
- One provider: `giftCards.providers.bitcoinCompany.enabled: false`. Countries
  routed to it get `GIFT_CARD_PROVIDER_UNAVAILABLE` on catalog, quote and
  purchase; settlement resolves the adapter by registration
  (`getRegisteredGiftCardProviderOrError`), so its in-flight orders keep
  reconciling as above.
- Open-loop only: `giftCards.allowOpenLoop: false`.

## (e) Rotate TBC credentials; rotate the claim key

**TBC credentials.** Change `providers.bitcoinCompany.email`/`password` in the
overrides, roll the pods, then clear the cached session so no pod keeps using
the old refresh token:
`redis-cli DEL giftcards:auth:bitcoinCompany giftcards:auth:bitcoinCompany:lock`.
The next authenticated call logs in fresh (`Bitcoin Company login succeeded`).
If TBC revokes the old credentials first, calls fail with
`GIFT_CARD_VENDOR_UNAVAILABLE` and a Critical `BitcoinCompanyAuthError` until
the new ones deploy; the refresh path retries login on every call.

**Claim key.** `claimDataEncryptionKey` is a single key; no multi-key map yet.
It must load before any money moves: empty or malformed, every `giftCardPurchase`
fails its order at the pay step (`claim-key-not-configured`, after the vendor
order exists, before IBEX is called) and returns `GIFT_CARD_CLAIM_UNAVAILABLE`. `claimKeyId`
(first 16 hex chars of sha256 of the key bytes) is stored on every `FULFILLED`
order and the ciphertext is bound (GCM AAD) to that key id **and** the order
id, so a ciphertext copied onto another order fails to decrypt. After a
rotation every existing `FULFILLED` order's `claimKeyId` mismatches:
`decryptGiftCardClaim` returns `GiftCardClaimCryptoError("key rotated")`,
`giftCardOrder` returns `claim: null` and logs Critical, only the purchase
payload shows `GIFT_CARD_CLAIM_UNAVAILABLE`. A rotation is therefore a
re-encryption migration — decrypt under the old key, encrypt under the new for
the same order id, update `claimCiphertext` + `claimKeyId`, order by order, in
a script that never logs plaintext. Count what is affected first:

```
Q='{"status":"FULFILLED","claimKeyId":{"$ne":"<new key id>"}}'
```

Get the new key id from `giftCardClaimKeyId()` (`src/services/gift-cards/claim-crypto.ts`)
with the new key configured. Never rotate without the script: losing the old
key makes every stored claim unreadable for good.

## (f) Flip limits `log-only -> enforce`

Mirror `docs/send-guard.md` "Flipping to enforce". Run at least a week in
`log-only` with real traffic, then:

1. Count `giftcard / would-reject` by `meta.reason` from the span attribute
   `giftcard.limits.reason` (not Discord). `limits-unavailable` must be **zero**
   (on enforce it refuses with `GIFT_CARD_UNKNOWN` and pages; non-zero means
   Mongo/Redis read faults). `daily-cap`, `per-card-cap`, `velocity` are real
   customers the caps would refuse: raise `perLevel.*` or the account's level
   **before** enforcing if legitimate. `vendor-daily-cap`, `vendor-card-cap`
   are TBC's FinCEN limits; never raise them. `level-not-eligible`,
   `account-too-new`, `open-loop-not-allowed` are expected; confirm the counts.
2. Confirm the hold path is healthy: no `Could not write gift card
   reservation; allowing in log-only mode` warnings (a refusal on enforce).
3. Set `giftCards.limits.mode: enforce`, `helm upgrade`, roll the api pods, and
   watch `giftcard / rejected` for a day. Roll back with `log-only` (or `off`
   if the limits code itself is the outage), same pod roll.

## (g) Catalog stale or sync failing

Symptoms: `catalog-stale` events, then `GIFT_CARD_CATALOG_UNAVAILABLE` once
`staleAfterSeconds` passes; `catalog-sync-failed` events (a pull that received
zero rows, or kept none after mapping, is a failure by design: the previous
catalog keeps serving); no `catalog-synced` for > 2 x `syncIntervalSeconds`.

1. Last sync time: `redis-cli GET giftcards:catalog-sync:last-run` and
   `redis-cli TTL giftcards:catalog:bitcoinCompany:countries`.
2. Cron logs: `gift card catalog sync finished` with `summaries: []` means
   skipped (lock held, marker within interval, Redis down) or every provider
   failed; `gift card catalog sync failed` carries the error.
3. Vendor down (`GiftCardVendorUnavailableError`; `listProducts` retries 3x on
   5xx/network): wait; a failed run releases the interval marker so the next
   tick retries. Check `GET $BASE_URL/giftcards?size=1&offset=0` answers.
4. Stuck lock: `redis-cli TTL giftcards:catalog-sync:lock` (lapses in 10 min);
   delete it only if the run that took it is confirmed dead.
5. Force a refresh: `redis-cli DEL giftcards:catalog-sync:last-run`, then
   trigger the k8s CronJob (`syncGiftCardCatalogsJob`) once; no CLI entry point.
6. The adapter's sync log carries `{ received, kept, skipped: {...}, flagged:
   { notResellable } }`. Skip reasons (`PRODUCT_MAPPING_SKIP_REASONS` in
   `mapping.ts`): `invalid`, `noCountry`, `physical`, `noLightning`,
   `unknownDenominationType`, `noDenominations`. `resellingEnabled: false` rows
   are **kept** and counted under `flagged.notResellable` (TBC shows false on
   every row until KYB; ENG-586 flips it to a skip). A jump in any bucket means
   the vendor changed a field (`mapVendorProduct`).

## (h) Adding a new provider

Checklist, using `src/services/gift-cards/bitcoin-company/` as the template:

1. Add the id to `GiftCardProviderId` / `GIFT_CARD_PROVIDER_IDS`
   (`src/domain/gift-cards/index.types.d.ts`, `primitives.ts`) and
   `providers.<id>` to `src/config/schema.ts`, `schema.types.d.ts`,
   `dev/config/base-config.yaml` and the `routing` enums.
2. Write the adapter: `client.ts` (transport, auth, retries on idempotent
   reads only, never on order creation), `schemas.ts` (zod on every response),
   `mapping.ts` (pure vendor -> domain, minor units, `maxQuantity` and
   `wholeUnitsOnly`, a status table that never reports `fulfilled` without a
   claim), `index.ts` exporting an idempotent `register<Vendor>Provider()`.
3. Register it in `src/services/gift-cards/index.ts` (the router requires
   registration **and** `providers.<id>.enabled`); redact the vendor's
   token/claim field names if the client logs bodies.
4. Tests: `client.spec.ts`, `mapping.spec.ts`, and a `contract.spec.ts` calling
   `runGiftCardProviderContract` (`test/flash/unit/services/gift-cards/provider-contract.ts`).
5. Webhooks, if any, route into `settleOrderFromVendor`; never a second path.
6. Config: `providers.<id>.enabled: true` and `routing.byCountry` entries; the
   registry, master gate, catalog sync and `globals.giftCardsEnabled` pick it
   up with no further code. Add alerts to ALERTING.md, rotation to (e).

## (i) A `paid-not-recorded` page

IBEX confirmed the send but the `PAID` write failed; the customer was handed
the order as it stood and told to poll. Until the row says `PAID` the worker
treats it as unpaid and, past `expiresAt`, expires it unless the vendor has
seen the payment.

1. Find it: `meta.orderId` from the page, or
   `Q='{"providerPaymentRef":"<meta.providerPaymentRef>"}'`. Read `status`,
   `paymentHash`, `invoiceSats`, `walletId`.
2. Confirm at IBEX (dashboard or `Ibex.getTransactionDetails`) that the send
   for `paymentHash` settled. If IBEX shows it failed, leave the order alone;
   the worker's re-read writes `PAYMENT_FAILED`.
3. Already `PAID` / `FULFILLED` / `REFUND_REQUIRED`: the worker or a replay
   recorded it after the page; nothing to do.
4. Otherwise engineering transitions it via the repository — `INVOICE_ISSUED |
   PAYMENT_PENDING | EXPIRED -> PAID`, reason `payment-settled`
   (`payment-settled-after-expiry` from `EXPIRED`), patch `paidSats:
   invoiceSats` and `providerPaymentRef` — never by editing `status` directly.
   The next run polls the vendor and fulfils or, after 24 h, escalates per (a).
