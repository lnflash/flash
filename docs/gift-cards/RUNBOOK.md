# Gift Cards Runbook

Operator procedures. Mongo queries use the node + mongoose one-liner pattern
from `docs/bridge-integration/ENG-276-IMPLEMENTATION-RESUME.md` (the repo does
not ship `mongosh`); run them from a pod or a jumpbox with `MONGODB_CON` set.
Redis commands assume `redis-cli` against the cluster's Redis (locally,
`make redis-cli`). Config changes follow `docs/send-guard.md`: edit the values
file, `helm upgrade`, then roll the api, trigger **and** cron workloads; the
YAML is read once at process start.

Helper used throughout (replace the query):

```bash
export Q='{"status":"REFUND_REQUIRED"}'
node -e "const m=require('mongoose');(async()=>{await m.connect(process.env.MONGODB_CON);const r=await m.connection.db.collection('giftcardorders').find(JSON.parse(process.env.Q),{projection:{_id:0,claimCiphertext:0,claimKeyId:0}}).sort({updatedAt:1}).limit(50).toArray();console.log(JSON.stringify(r,null,2));await m.disconnect();})().catch(async e=>{console.error(e);process.exit(1)})"
```

The projection **excludes** `claimCiphertext` and `claimKeyId`; never print
them, and never decrypt a claim outside the owner-scoped read
(`getGiftCardOrderForAccount`).

## (a) A `REFUND_REQUIRED` order

The only state that means money left Flash and no card came. It pages
(`giftcard / refund-required`, see ALERTING.md).

1. Find it. From the page, `meta.orderId`; or list them all:
   `Q='{"status":"REFUND_REQUIRED"}'`. Read `id`, `accountId`, `walletId`,
   `valueMinor`, `quantity`, `currency`, `paidSats`, `paymentHash`,
   `providerId`, `providerOrderId`, `paymentRequest`, `providerPaymentRef`
   (the IBEX transaction id), `failureReason`, and `statusHistory` (when PAID
   was written and why REFUND_REQUIRED followed: `vendor-failed: ...`,
   `vendor-refunded: ...`, or `fulfillment-timeout`).
2. Confirm our payment. In the IBEX dashboard (or `Ibex.getTransactionDetails`
   with `providerPaymentRef`) verify the send for `paymentHash` settled. If
   IBEX shows it failed, the order should never have been PAID; note that and
   continue, since the state is terminal.
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
   order was escalated on a timeout and the card exists: skip to step 5b.
4. Chase the refund. Open a ticket with TBC support quoting our order id (their
   label), their order uuid (`providerOrderId`), the invoice, and the paid
   amount. TBC refunds to the account balance or by Lightning; record which.
5. Record the outcome. There is no transition out of `REFUND_REQUIRED`
   (`GIFT_CARD_TRANSITIONS`), by design. Either:
   - **5a. Refund received:** credit the user's wallet by the standard
     support path for a manual credit, then annotate the order with a
     `$set` of `failureReason` to
     `"<existing>; refunded <date> <reference>"` (only that field). Reply to
     the page thread with the order id and the credit reference.
   - **5b. Card actually issued:** ask engineering to run the settlement by
     hand (`fetchAndSettle(order)` will refuse because the order is terminal;
     `settleOrderFromVendor` on a terminal order pages
     `vendor-fulfilled-unexpected`). This case needs a code path or a
     one-off script that re-encrypts the claim onto the order; do not paste
     claim codes anywhere.
6. Tell the customer. They must not be told to buy again; the app already
   shows the `REFUND_REQUIRED` copy.

## (b) Order stuck in `PAID` > 15 min

Normal fulfilment is seconds. The worker polls at 5s/15s/60s/5m then every
15m, and escalates to `REFUND_REQUIRED` only at 24 h. A PAID order older than
15 min is a vendor delay or a worker problem.

1. `Q='{"status":"PAID","updatedAt":{"$lt":{"$date":"<ISO 15 min ago>"}}}'`.
   Note the JSON date form; adjust the timestamp.
2. Is the worker running? In the trigger pod logs look for
   `gift card reconcile finished` (cron) or reconcile tick warnings. If every
   run says `skipped: lock-held`, a run died holding the lock; it lapses after
   5 min (`giftcards:reconcile:lock`). Check `giftCards.enabled` is true in the
   trigger and cron config, not just the api.
3. Check the vendor for that invoice (step (a)3). `unpaid`/`underpaid`/
   `confirming` while we show PAID means IBEX settled and TBC has not seen it:
   compare `paidSats` with the invoice amount and escalate to TBC. `pending` /
   `senttofulfillment` is a vendor delay: wait for the 15-minute poll.
   `completed` without `claimData` is held as pending by design; ask TBC.
4. Do not move the order by hand. If the vendor confirms the card will not
   come, the 24 h timeout will write `REFUND_REQUIRED`; to bring that forward,
   engineering can run `settleOrderFromVendor(order, { kind: "failed", reason })`
   from a script.

## (c) Order stuck in `PAYMENT_PENDING` with no `providerPaymentRef`

The worker cannot re-read IBEX without the transaction id, and there is no
hash-based fallback on this rail (`lookupSentPaymentStatus`). After 60 min it
logs `Gift card payment has been pending for over an hour with no resolvable
status` every run.

1. `Q='{"status":"PAYMENT_PENDING","providerPaymentRef":null}'`. Read
   `paymentHash`, `paymentRequest`, `walletId`, `invoiceSats`.
2. In the IBEX dashboard, find the outgoing payment on account `walletId`
   for `paymentHash`.
3. Settled: `$set` `providerPaymentRef` to the IBEX transaction id (only that
   field). The next worker run re-reads IBEX, moves the order to `PAID`, and
   polls the vendor.
4. Failed at IBEX: same `$set` of the transaction id; the worker will write
   `PAYMENT_FAILED`. If IBEX has no record at all, the send never left; ask
   engineering to transition `PAYMENT_PENDING -> PAYMENT_FAILED` with reason
   `payment-failed` via the repository, not by editing `status` directly (the
   `statusHistory` push matters for audits).

Orders that show `PAYMENT_PENDING` **with** a ref for more than an hour are an
IBEX question: the transaction exists but reports no recognised payment
status. Escalate to IBEX with the transaction id.

## (d) Disable the feature or one provider

One config change, then roll api + trigger + cron:

- Whole rail: `giftCards.enabled: false`. Catalog, quote and purchase return
  `GIFT_CARDS_DISABLED`, `globals.giftCardsEnabled` is false, both jobs
  no-op. `giftCardOrder` / `giftCardOrders` keep working so customers can
  still read cards they own. **In-flight orders stop being reconciled**;
  expect to come back within 24 h or handle PAID orders by hand.
- One provider: `giftCards.providers.bitcoinCompany.enabled: false`. Countries
  routed to it get `GIFT_CARD_PROVIDER_UNAVAILABLE`; `fetchAndSettle` refuses
  those orders (`getEnabledGiftCardProvider`), so the same in-flight caveat
  applies to that provider's orders.
- Open-loop only: `giftCards.allowOpenLoop: false`.
- Kill new purchases but keep settling: there is no such switch today; the
  closest is `limits.mode: enforce` with `perLevel.*.perCardCents: 0`, which
  refuses every purchase with `GIFT_CARD_LIMIT_EXCEEDED` while the worker
  keeps running.

Not live-reloaded; budget for a pod roll.

## (e) Rotate TBC credentials; rotate the claim key

**TBC credentials.** Change `providers.bitcoinCompany.email`/`password` in the
overrides, roll the pods, then clear the cached session so no pod keeps using
the old refresh token:

```
redis-cli DEL giftcards:auth:bitcoinCompany giftcards:auth:bitcoinCompany:lock
```

The next authenticated call logs in fresh (`Bitcoin Company login succeeded`).
If TBC revokes the old credentials first, calls fail with
`GIFT_CARD_VENDOR_UNAVAILABLE` and a Critical `BitcoinCompanyAuthError` until
the new ones are deployed; the refresh path retries login on every call, so
nothing else needs resetting.

**Claim key.** `claimDataEncryptionKey` is a single key; there is no multi-key
map yet. `claimKeyId` (first 16 hex chars of sha256 of the key bytes) is stored
on every `FULFILLED` order so a reader can tell which key sealed it. What
happens on a rotation:

- New orders encrypt under the new key with the new `claimKeyId`.
- Every existing `FULFILLED` order's `claimKeyId` no longer matches;
  `decryptGiftCardClaim` returns `GiftCardClaimCryptoError("key rotated")` and
  the customer sees `GIFT_CARD_CLAIM_UNAVAILABLE`.

So a rotation today is a re-encryption migration: decrypt under the old key,
encrypt under the new, update `claimCiphertext` + `claimKeyId`, order by
order, in a script that never logs plaintext. Count what is affected first:

```
Q='{"status":"FULFILLED","claimKeyId":{"$ne":"<new key id>"}}'
```

Get the new key id from `giftCardClaimKeyId()` in
`src/services/gift-cards/claim-crypto.ts` with the new key configured. Do not
rotate without the script; losing the old key makes every stored claim
unreadable for good.

## (f) Flip limits `log-only -> enforce`

Mirror `docs/send-guard.md` "Flipping to enforce":

1. Run at least a week in `log-only` with real traffic.
2. Count `giftcard / would-reject` by `meta.reason` from the span attribute
   `giftcard.limits.reason` (not from Discord):
   - `limits-unavailable` must be **zero**. On enforce it refuses the purchase
     with `GIFT_CARD_UNKNOWN` and pages. Non-zero means Mongo or Redis faults on
     the read path; fix those first.
   - `daily-cap`, `per-card-cap`, `velocity`: real customers the caps would
     refuse. If any of it is legitimate, raise `perLevel.*` or the account's
     level **before** enforcing.
   - `vendor-daily-cap`, `vendor-card-cap`: never raise these; they are TBC's
     FinCEN exemption limits.
   - `level-not-eligible`, `account-too-new`, `open-loop-not-allowed`:
     expected; confirm the counts match the product decision.
3. Confirm the reservation hold path is healthy: no
   `Could not write gift card reservation; allowing in log-only mode` warnings.
   On enforce that warning becomes a refusal.
4. Set `giftCards.limits.mode: enforce`, `helm upgrade`, roll the api pods.
5. Watch `giftcard / rejected` for the first day. Roll back with `log-only`
   (or `off` if the limits code itself is the outage), same pod roll.

## (g) Catalog stale or sync failing

Symptoms: `catalog-stale` events, then `GIFT_CARD_CATALOG_UNAVAILABLE` once
`staleAfterSeconds` passes; `catalog-sync-failed` events; no
`catalog-synced` for > 2 x `syncIntervalSeconds`.

1. Read the last sync time: `redis-cli GET giftcards:catalog-sync:last-run`
   and `redis-cli TTL giftcards:catalog:bitcoinCompany:countries`.
2. Cron logs: `gift card catalog sync finished` with `summaries: []` means it
   was skipped (lock held, marker within interval, or Redis down) or every
   provider failed. `gift card catalog sync failed` carries the error.
3. Vendor down (`GiftCardVendorUnavailableError`, `listProducts` retries 3x
   on 5xx/network): nothing to do but wait; a failed run releases the interval
   marker so the next cron tick retries. Confirm
   `GET $BASE_URL/giftcards?size=1&offset=0` answers (no auth needed).
4. Stuck lock: `redis-cli TTL giftcards:catalog-sync:lock`; it lapses in 10 min.
   Delete it only if the run that took it is confirmed dead.
5. Force a refresh now: `redis-cli DEL giftcards:catalog-sync:last-run` and
   run the cron job (`syncGiftCardCatalogsJob`) once. There is no CLI entry
   point; trigger the k8s CronJob manually.
6. Rows skipped during mapping (`no-country`, `unknown-denomination-type`,
   `no-denominations`) are logged by `Bitcoin Company catalog mapped`; a sudden
   jump means the vendor changed a field. See `mapVendorProduct`.

## (h) Adding a new provider

Checklist, using `src/services/gift-cards/bitcoin-company/` as the template:

1. Add the id to `GiftCardProviderId` and `GIFT_CARD_PROVIDER_IDS`
   (`src/domain/gift-cards/index.types.d.ts`, `primitives.ts`); add
   `providers.<id>` to `src/config/schema.ts`, `schema.types.d.ts`,
   `dev/config/base-config.yaml`, and the `routing` enums.
2. Write the adapter: `client.ts` (transport, auth, retries on idempotent
   reads only, never retry order creation), `schemas.ts` (zod on every
   response), `mapping.ts` (pure vendor -> domain, minor units, a status table
   that never reports `fulfilled` without a claim), `index.ts` exporting an
   idempotent `register<Vendor>Provider()`.
3. Register it in `src/services/gift-cards/index.ts` (one import + call).
4. Redact: add the vendor's token/claim field names to the log redaction set
   if the client logs bodies.
5. Tests: a `client.spec.ts`, a `mapping.spec.ts`, and a `contract.spec.ts`
   that calls `runGiftCardProviderContract`
   (`test/flash/unit/services/gift-cards/provider-contract.ts`).
6. If the vendor pushes webhooks, route them into `settleOrderFromVendor`;
   do not add a second settlement path.
7. Config: `providers.<id>.enabled: true` and `routing.byCountry` entries;
   the registry, master gate, catalog sync and `globals.giftCardsEnabled`
   pick it up with no further code.
8. Add its ops-event/alert specifics to ALERTING.md and its credential
   rotation to (e) above.
