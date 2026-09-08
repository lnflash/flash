# Send guard (ENG-573 Phase 0)

`Payments.authorizeSend` (`src/app/payments/authorize-send.ts`) is the only
Flash-side check on a user-initiated send. Flash has no internal ledger, so
Galoy's `AccountLimitsChecker` reads a volume of zero for every account and never
rejects; on 2026-09-03 a $999,999,999.99 intraledger request reached IBEX
untouched.

Every send mutation runs it before anything reaches IBEX. On every rail that
accepts an `idempotencyKey`, it runs as `withPaymentIdempotency`'s `authorize`
hook — inside the lock, after the cache re-check, immediately before the send —
so a replayed key returns the cached result without spending attempt budget or
being re-judged against a moved mid price. Ahead of the wrapper, a client
retrying a timed-out send burned a burst point per retry and, past 10/min, got
"Too many payment attempts" for a payment that had already settled.

The checks:

1. **attempt budget** — two Redis buckets keyed on the account, a burst bucket
   (10/min) and a daily bucket (200/day). Every attempt costs a point, rejected
   ones included, so probing the amount space is bounded by the caller's own
   budget.
2. **amount sanity** — positive and finite. USD/USDT cents may be fractional
   (USDT settles in micros); sats must be whole.
3. **daily limit as per-transaction cap** — `amount <= dailyLimit(level)`.
   Intraledger sends use the intraLedger limit; everything leaving Flash uses the
   withdrawal limit. Phase 1 replaces this with the remaining allowance.

## The operator switch

`sendGuard.mode` in the values yaml. Default **`log-only`**.

| mode       | behaviour                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| `off`      | Returns immediately. No Redis, no price lookup, no ops event. Pre-ENG-573 behaviour.                     |
| `log-only` | All checks run, every would-be rejection posts a `transfer / would-reject` ops event — the send proceeds. Includes `lnInvoicePaymentSend`'s bolt11 decode gate: an undecodable or no-amount invoice is reported and still handed to IBEX, exactly as before ENG-573. |
| `enforce`  | Rejections are real.                                                                                     |

Anything unrecognised degrades to `log-only`. The failure mode of this switch
must be "the guard does not block", never "every send is refused".

`off` covers **everything** ENG-573 added, not just the three checks.
`lnInvoicePaymentSend` also gained a bolt11 decode gate — the guard needs the
amount and the amount is inside the invoice, so the resolver decodes it where it
previously handed the raw bolt11 straight to IBEX. `decodeInvoice` refuses
anything `invoices.parsePaymentRequest` cannot parse and any invoice with no
payment secret, which is a rejection class that rail never had. That gate lives
inside the same `authorize` hook and answers to the same switch: on `off` the
resolver does not decode at all, so an invoice IBEX would have paid is restored
by the flag rather than by a deploy.

The decode gate charges the attempt budget too, exactly once per request — a
request the gate handles never reaches `authorizeSend`, and vice versa. It has
to: the `LnPaymentRequest` scalar is `/^ln[a-z0-9]+$/i`, so `paymentRequest:
"lnx"` is a well-formed request that fails the decode, and without a charge it
would be the one send outcome an authenticated caller could produce without
limit.

## Why it ships in log-only

These caps are the first Flash-side amount limits that have ever rejected
anything, and no measurement exists of what fraction of real traffic they refuse.
The sharpest case is the decision to read a missing `level` field as level 0:
~300 prod accounts have no `level` (174 of them with usernames, i.e. active
users), and on `enforce` they are capped at $125 per transaction. "An unleveled
account is an unverified one" is an assumption, not a verified fact about those
accounts.

That assumption lives in exactly one place — `effectiveAccountLevel`, applied
inside `getAccountLimits` — so the guard, `Account.limits` and `remainingLimit`
all read the same numbers for those accounts. Revising it is a one-line change
there, not a hunt through the call sites.

`log-only` turns that assumption into data instead of into an incident.

## Flipping to enforce

1. Deploy with `sendGuard.mode: log-only` (the default — nothing to set).
2. Watch the ops feed for `🔁 Transfer — Would Reject` embeds for at least a full
   day, ideally a week (weekly payout and settlement patterns are the ones that
   sit near a cap). Each embed carries the account, the level, the amount and the
   reason in `step`.
3. Count them by `step`:
   - `over-daily-limit` — real traffic the cap would have refused. If any of it
     is legitimate, raise the level's limit or the account's level *before*
     enforcing; do not enforce and then triage support tickets.
   - `invalid-amount` — malformed client input. Should be near zero.
   - `limits-unavailable` — Redis or the price feed failing, i.e. the guard
     itself unable to decide. Must be zero before enforcing: on `enforce` these
     block the send. They are also recorded as span exceptions
     (`ErrorLevel.Critical` when enforcing, `Warn` in log-only) — alert on that
     signal, because a price-pod outage past the 10-minute price cache rejects
     every amount-bearing lightning send and every BTC intraledger send.
   - `rate-limited` is **coalesced**, not silent. Silencing it would leave one
     of the three checks with no observable output at all — unreadable during
     the very rollout this mode exists for, so an operator would count a week of
     would-reject embeds, see no rate-limit signal by construction, flip to
     enforce, and hand a 30-payment payout batch twenty `TooManyRequestError`s.
   - `undecodable-invoice` is `lnInvoicePaymentSend` only: the bolt11 could not
     be decoded, or carried no amount. The guard introduced that decode, so this
     is a rejection class the rail never had — count it before enforcing. Also
     **coalesced**; count it from the span attributes below, not by tallying
     embeds.

   **What is coalesced.** `rate-limited`, `limits-unavailable` and
   `undecodable-invoice` are capped at **one embed per minute each**, because
   nothing else bounds how many of them can arrive at once: a client in a retry
   loop keeps producing the first and the third after its budget is spent, and a
   Redis or price-pod fault makes every send in flight report the second in the
   same instant. Uncapped, any of the three fills the 50-deep queue and pushes
   the verification / cashout / deposit feed out of it. `over-daily-limit` and
   `invalid-amount` are never coalesced: they are the per-account facts this
   rollout exists to read one by one, and each is raised only after the caller's
   attempt budget has been charged, so the budget bounds them.

   **What the embed tells you.** The one that does post carries `muted: N` in
   its meta — how many events of that reason were coalesced away since the last
   one that posted — plus `mutedAgeS`, how many seconds ago the window that
   accumulated them opened. A count is only ever cleared by being delivered: a
   40-second blip that mutes 499 rejections and then goes quiet reports all 499
   on the next embed of that reason, however much later, and `mutedAgeS` is what
   tells you they are an older incident rather than 499 that just happened.

   **What to count from.** Every rejection, of every reason, coalesced or not,
   is also written to the current span as `sendGuard.rejection`,
   `sendGuard.mode`, `sendGuard.kind`, `sendGuard.level`, `sendGuard.error` and
   (when the guard got as far as an amount) `sendGuard.cents`. Count from
   tracing, not from Discord: the ops feed is fire-and-forget, does nothing at
   all when `OPS_DISCORD_WEBHOOK_URL` is unset, and drops its oldest entries on
   overflow behind an unattributed "N events dropped" summary. Read the feed,
   count the spans.

   **What to alert on.** `limits-unavailable` additionally records a span
   *exception* on every occurrence, unthrottled — `ErrorLevel.Critical` when
   enforcing, `Warn` in log-only. That is the page-worthy signal: it means the
   guard cannot decide, and on `enforce` that blocks the send.
4. Set `sendGuard.mode: enforce`, `helm upgrade`, and **restart the api pods**
   (see below) — the mode is read once at process start.

## Rolling back

Same flag: `log-only`, or `off` if the guard itself is the outage.

**It is not live-reloaded.** `yamlConfig` is read once from `--configPath` when
the process starts (`src/config/yaml.ts`), and `getSendGuardMode()` reads that
frozen object. Editing the value in the values file changes nothing until the
pods are replaced:

```sh
# 1. change sendGuard.mode in the values file, then
helm upgrade <release> <chart> -f <values>
# 2. replace the pods — unless the chart carries a configmap-checksum
#    annotation that already does it (verify before relying on it)
kubectl rollout restart deploy/<api>
kubectl rollout status  deploy/<api>
```

Budget for a pod roll, not for an instant flag flip. If you need the guard to
stop blocking *now* and the roll is too slow, `off` costs the same restart —
there is no faster switch, which is worth knowing before the incident rather
than during it.

## Related config

- `accountLimits.*.level` — the caps. **Every level 0-3 is `required`**: a
  deployment that overrides `accountLimits` partially fails at boot rather than
  resolving a missing level to `NaN` and silently blocking that level's sends.
  An *account* with no level is separate: `getAccountLimits` resolves that to
  level 0 via `effectiveAccountLevel` before indexing.
- `rateLimits.paymentSendAttempt` / `paymentSendDailyAttempt` — the two buckets.
  `blockDuration` must be **>= `duration`**: rate-limiter-flexible rewrites the
  key's TTL to `blockDuration` on the first breach, so a shorter block throws the
  counter away early and grants a fresh budget (a 3600s block on an 86400s window
  is 200/hour, ~4,800/day, not 200/day).
