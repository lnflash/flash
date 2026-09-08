# Send guard (ENG-573 Phase 0)

`Payments.authorizeSend` (`src/app/payments/authorize-send.ts`) is the only
Flash-side check on a user-initiated send. Flash has no internal ledger, so
Galoy's `AccountLimitsChecker` reads a volume of zero for every account and never
rejects; on 2026-09-03 a $999,999,999.99 intraledger request reached IBEX
untouched.

Every send mutation runs it before anything reaches IBEX:

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
| `log-only` | All checks run, every would-be rejection posts a `transfer / would-reject` ops event — the send proceeds. |
| `enforce`  | Rejections are real.                                                                                     |

Anything unrecognised degrades to `log-only`. The failure mode of this switch
must be "the guard does not block", never "every send is refused".

## Why it ships in log-only

These caps are the first Flash-side amount limits that have ever rejected
anything, and no measurement exists of what fraction of real traffic they refuse.
The sharpest case is the decision to read a missing `level` field as level 0:
~300 prod accounts have no `level` (174 of them with usernames, i.e. active
users), and on `enforce` they are capped at $125 per transaction. "An unleveled
account is an unverified one" is an assumption, not a verified fact about those
accounts.

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
   - `rate-limited` posts **no** ops event by design: the limiter has already
     bounded that caller, its counters live in Redis, and a client in a retry
     loop would otherwise fill the 50-deep ops queue and push the verification /
     cashout / deposit feed out of it.
4. Set `sendGuard.mode: enforce` and redeploy.

Rolling back is the same flag: `log-only`, or `off` if the guard itself is the
outage.

## Related config

- `accountLimits.*.level` — the caps. **Every level 0-3 is `required`**: a
  deployment that overrides `accountLimits` partially fails at boot rather than
  resolving a missing level to `NaN` and silently blocking that level's sends.
- `rateLimits.paymentSendAttempt` / `paymentSendDailyAttempt` — the two buckets.
  `blockDuration` must be **>= `duration`**: rate-limiter-flexible rewrites the
  key's TTL to `blockDuration` on the first breach, so a shorter block throws the
  counter away early and grants a fresh budget (a 3600s block on an 86400s window
  is 200/hour, ~4,800/day, not 200/day).
