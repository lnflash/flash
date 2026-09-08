# Send guard (ENG-573 Phase 0)

`Payments.authorizeSend` (`src/app/payments/authorize-send.ts`) is the only
Flash-side check on the send mutations. Flash has no internal ledger, so Galoy's
`AccountLimitsChecker` reads a volume of zero for every account and never
rejects; on 2026-09-03 a $999,999,999.99 intraledger request reached IBEX
untouched.

It is **not** the only user-initiated path that moves a user's money. Cashout
pays a bolt11 out of the user's own wallet, and `bridgeInitiateWithdrawal` sends
the user's own USDT out through IBEX, without either one ever touching the
guard — read [Not covered by the guard at
all](#not-covered-by-the-guard-at-all) before concluding from this page that a
rail is guarded.

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
3. **daily limit as per-transaction cap** — `amount <= dailyLimit(level)`. The
   `intraledger` rails use the intraLedger limit; every lightning, lnurl and
   on-chain rail uses the withdrawal limit. Phase 1 replaces this with the
   remaining allowance.

   **"Withdrawal" here means the rail, not the destination.** A bolt11 or
   LN-address payment to another Flash user never leaves Flash, but every
   lightning and lnurl rail passes `kind: "lightning"` / `"lnurl"` and is judged
   against `withdrawalLimit` — the destination is not knowable at the guard,
   which runs before the payment flow that resolves it. That is a deliberate
   approximation for Phase 0, and it is visible in exactly one place: **level
   1**, the only level whose two schema defaults differ — withdrawal $1,000,
   intraLedger $2,000 (`src/config/schema.ts`, and no deployment overrides
   `accountLimits`). Levels 0, 2 and 3 carry equal limits, so on those the
   distinction cannot change an outcome. On `enforce`, an L1 user paying another
   Flash user $1,500 is therefore refused by their lightning invoice and allowed
   by their username.

   Decide this before flipping, not after: either raise
   `accountLimits.withdrawal.level.1` to `200000` so the two agree and the
   approximation stops mattering, or accept the L1 discrepancy knowingly. Phase
   1, which resolves the destination before charging an allowance, is where the
   approximation actually goes away.

## The operator switch

`sendGuard.mode` in the values yaml. Default **`log-only`**.

| mode       | behaviour                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| `off`      | Returns immediately. No Redis, no price lookup, no ops event, no span attribute. Pre-ENG-573 behaviour **for the guard** — but not for the level-0 default: an account with no `level` field is still capped at the level-0 limits, unconditionally, by Galoy's own checker. See [What `off` does not cover](#what-off-does-not-cover). |
| `log-only` | All checks run, every would-be rejection posts a `transfer / would-reject` ops event — the send proceeds. Includes `lnInvoicePaymentSend`'s bolt11 decode gate: an undecodable or no-amount invoice is reported and still handed to IBEX, exactly as before ENG-573. |
| `enforce`  | Rejections are real.                                                                                     |

Anything unrecognised degrades to `log-only`. The failure mode of this switch
must be "the guard does not block", never "every send is refused".

`off` covers every check the guard itself runs, not just the three above (see
[What `off` does not cover](#what-off-does-not-cover) for the one thing ENG-573
changed that it does not). `lnInvoicePaymentSend` also gained a bolt11 decode
gate — the guard needs the amount and the amount is inside the invoice, so the
resolver decodes it where it previously handed the raw bolt11 straight to IBEX.
`decodeInvoice` refuses anything `invoices.parsePaymentRequest` cannot parse and
any invoice with no payment secret, which is a rejection class that rail never
had. That gate lives inside the same `authorize` hook and answers to the same
switch: on `off` the resolver does not decode at all, so an invoice IBEX would
have paid is restored by the flag rather than by a deploy.

The decode gate charges the attempt budget too, exactly once per request — a
request the gate handles never reaches `authorizeSend`, and vice versa. It has
to: the `LnPaymentRequest` scalar is `/^ln[a-z0-9]+$/i`, so `paymentRequest:
"lnx"` is a well-formed request that fails the decode, and without a charge it
would be the one send outcome an authenticated caller could produce without
limit.

### What `off` does not cover

One thing ENG-573 changed is **not** behind the switch: reading an account with
no `level` field as level 0. That default lives in `effectiveAccountLevel`,
applied inside `getAccountLimits` (`src/config/yaml.ts:186`) — the config layer,
deliberately, so the guard, `Account.limits` and `remainingLimit` cannot
disagree about those ~300 accounts. Galoy's own `AccountLimitsChecker` reads the
same function (`src/app/payments/helpers.ts:185`), so it caps an unleveled
account at the level-0 limits **on every mode, `off` included** — and because
the guard is not involved, there is no ops event, no `would-reject` embed and no
`sendGuard.*` span attribute to explain it.

Where that bites is the BTC no-amount lightning pair, the only user-facing rails
still routed through `@app/payments` (the USD and amount-bearing resolvers are
FLASH FORK bodies that pay IBEX directly and never reach the checker, so on
those `off` really is pre-ENG-573 behaviour):

- `lnNoAmountInvoicePaymentSend` — `checkIntraledgerLimits` /
  `checkTradeIntraAccountLimits` at `src/app/payments/send-lightning.ts:484`
  when the invoice settles inside Flash, `checkWithdrawalLimits` at `:682` when
  it leaves. Over the cap, the caller gets Galoy's own
  `Cannot transfer more than $125.00 in 24 hours`.
- `lnNoAmountInvoiceFeeProbe` — the same three checks at
  `src/app/payments/get-protocol-fee.ts:178`, `:187` and `:196`, so the probe
  refuses before the send is ever attempted.

This is not a regression. Before ENG-573 that cohort indexed the level map with
`undefined`, got `NaN` limits, and `paymentAmountFromNumber(NaN)` returned a
`BigIntConversionError` out of `checkLimit` — the send failed anyway, with a
type error instead of a limit message. But it is not switchable either: if an
unleveled account has to send above the level-0 cap during an incident,
`sendGuard.mode: off` will not do it. Raise that account's `level`, or raise
`accountLimits.*.level` for level 0, and roll the pods.

## Not covered by the guard at all

`off` / `log-only` / `enforce` describe the rails that *call* the guard. The
following move money without it, on every mode — no attempt budget, no
per-transaction cap, and nothing in the `would-reject` sample or the
`sendGuard.*` census to count:

- **Cashout / offers — a gap, not a decision.** `ValidOffer.execute()` pays a
  bolt11 out of the user's own wallet via `Ibex.payInvoice`
  (`src/app/offers/ValidOffer.ts:68`), reached from the `initiateCashout`
  mutation through `CashoutManager.executeCashout`. Its compensating controls
  are `CashoutValidator`'s configured min/max — `cashout.minimum.amount` /
  `cashout.maximum.amount` in the values file, checked at
  `src/app/offers/Validator.ts:29` and `:44` — plus a balance check
  (`hasSufficientBalance`, `:75`), an account-level floor
  (`cashout.accountLevel`), and the bank-account / ERP-party checks. So the
  per-transaction ceiling on this rail is one number for every level, not
  `accountLimits`, and there is no attempt budget and no daily volume limit at
  all: the validator list ends with `// TODO daily/weekly/monthly volume
  limits`. Raising or lowering `accountLimits` does nothing here, and
  `sendGuard.mode: enforce` does not cap a cashout. Phase 1 should wire this
  rail in next.
- **Bridge USDT withdrawal — a gap, not a decision.** `bridgeInitiateWithdrawal`
  (`src/graphql/public/root/mutation/bridge-initiate-withdrawal.ts`) →
  `BridgeService.initiateWithdrawal` (`src/services/bridge/index.ts:1269`) moves
  the user's own USDT out through `IbexClient.sendCrypto` (`:1442`). Its only
  controls are a Bridge KYC-approved customer (`requireApprovedBridgeCustomer`),
  an account level of at least 1 (`checkAccountLevel`, `:299`, plus the
  resolver's own `level <= 0` guard), and an execution-time balance re-check.
  There is **no per-transaction ceiling at all** on this rail: the requesting
  half only asserts `amount > 0` and `amount <= balance`
  (`src/services/bridge/index.ts:1127` and `:1132`), there is no configured
  min/max the way cashout has one, and `accountLimits` is never consulted. These
  are the largest per-transaction amounts on the platform. Phase 1 should wire
  this rail in alongside cashout.
- **System credits — deliberate.** Quiz rewards, referral payouts, card top-up
  credits, operator reimbursements. They move money out of a Flash-owned funding
  wallet on our own instruction, so an account-scoped attempt budget and a
  per-account daily cap describe nothing about them (a 30-payment referral batch
  would rate-limit itself). They opt out **by name** via
  `SEND_GUARD_NOT_APPLICABLE` (`src/app/payments/send-guard-optout.ts`), which is
  also the grep that answers "what still sends without the guard".
- **The two stubbed on-chain resolvers.** `onchain-payment-send.ts` and
  `onchain-usd-payment-send-as-sats.ts` return `UnsupportedCurrencyError` with
  their send bodies commented out one line below. Nothing sends today; whoever
  re-enables them gets a compile error from the required `authorize` hook rather
  than an unguarded rail.

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
there, not a hunt through the call sites. The price of putting it there is that
`sendGuard.mode` does not reach it: see
[What `off` does not cover](#what-off-does-not-cover).

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
     enforcing; do not enforce and then triage support tickets. Read this bucket
     knowing it conflates two things at level 1: a `sendGuard.kind` of
     `lightning` or `lnurl` says which rail was used, not where the money went,
     so a payment that would have settled *inside* Flash is in here judged
     against the $1,000 withdrawal limit and is indistinguishable from a real
     external send (see check 3 above). L1 rows between $1,000 and $2,000 are
     the affected band; on every other level the two limits are equal and the
     bucket is unambiguous.
   - `invalid-amount` — malformed client input. Should be near zero. A
     send-all on an empty wallet is deliberately **not** in this bucket:
     `getBalanceForWallet` reads a drained or never-funded wallet as
     `USDAmount.ZERO` — post-cutover the default for every migrated account's
     legacy USD wallet — so `onchain-payment-send-all.ts` skips the guard when
     the balance rounds to zero cents and leaves the refusal to the rail, one
     layer down. Be clear about what that refusal is: `payOnChainByWalletId`
     reaches `OnchainUsdPaymentValidator`'s `checkOnchainMin`, which returns a
     bare `ValidationError("Amount must be greater than 0")`, and `mapError`
     has no case for it beyond the catch-all — the client gets `Unexpected error
     occurred, please try again or contact support if it persists (code:
     ValidationError: Amount must be greater than 0)`. That is unchanged by
     ENG-573 and not a good message, but it is not the guard's to fix here. The
     reason for the skip is the census: otherwise every ordinary empty-wallet
     tap would read as malformed client input, in the one bucket the runbook
     says should be near zero, in the sample the enforce decision is made
     from.
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

   **What to count from.** One span name: **`app.payments.authorizeSend`**
   (`SEND_GUARD_SPAN_NAME` in `src/app/payments/authorize-send.ts`). Every
   rejection, of every reason, coalesced or not, from every rail, is written
   there as `sendGuard.rejection`, `sendGuard.mode`, `sendGuard.kind`,
   `sendGuard.level`, `sendGuard.error` and (when the guard got as far as an
   amount) `sendGuard.cents`. The guard opens that span itself rather than
   writing to whatever span happens to be active, and that is load-bearing for
   this step: the ambient span differs by call path — on the six rails that take
   an `idempotencyKey` the guard runs inside
   `services.lock.lockPaymentIdempotencyKey`, and without a key, or on either
   on-chain rail, inside the GraphQL resolver span — so a query scoped to one of
   those names would have counted a fraction of the traffic, and the fraction
   that went missing is the newer mobile clients that send idempotency keys.
   Both entry points share the name; `code.function` on the span says whether it
   was `authorizeSend` or the `gateSend` decode gate.

   Every attribute is a **string** except `sendGuard.cents`, which is a number
   so it can be aggregated — so query `sendGuard.level = "0"`, not `= 0`, and
   read a level-0 or level-less account as the literal `"0"` rather than as an
   absent attribute. Range and percentile filters on `sendGuard.cents` are
   numeric. Count from tracing, not from Discord: the ops feed is
   fire-and-forget, does nothing at all when `OPS_DISCORD_WEBHOOK_URL` is unset,
   and drops its oldest entries on overflow behind an unattributed "N events
   dropped" summary. Read the feed, count the spans.

   **What to alert on.** `limits-unavailable` additionally records a span
   *exception* on every occurrence, unthrottled — `ErrorLevel.Critical` when
   enforcing, `Warn` in log-only. That is the page-worthy signal: it means the
   guard cannot decide, and on `enforce` that blocks the send.
4. Set `sendGuard.mode: enforce`, `helm upgrade`, and **restart the api pods**
   (see below) — the mode is read once at process start.

## Rolling back

Same flag: `log-only`, or `off` if the guard itself is the outage. Neither
restores sends for an account with **no `level` field** — that cap is enforced a
layer below the flag, silently, and no amount of mode-flipping lifts it. Read
[What `off` does not cover](#what-off-does-not-cover) before concluding the
rollback failed.

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
  level 0 via `effectiveAccountLevel` before indexing. That resolution is in the
  config layer, not the guard, so it is **unconditional** — `sendGuard.mode`,
  `off` included, does not lift it, and Galoy's `AccountLimitsChecker` goes on
  enforcing the level-0 cap on `lnNoAmountInvoicePaymentSend` and
  `lnNoAmountInvoiceFeeProbe` regardless of mode, with none of the guard's
  ops-event or span output to show for it. See
  [What `off` does not cover](#what-off-does-not-cover).
- `rateLimits.paymentSendAttempt` / `paymentSendDailyAttempt` — the two buckets.
  `blockDuration` must be **>= `duration`**: rate-limiter-flexible rewrites the
  key's TTL to `blockDuration` on the first breach, so a shorter block throws the
  counter away early and grants a fresh budget (a 3600s block on an 86400s window
  is 200/hour, ~4,800/day, not 200/day).
