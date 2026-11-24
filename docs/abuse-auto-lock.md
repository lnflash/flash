# Abuse auto-lock

Locks an account that keeps sending requests the Flash apps cannot produce, and
flags it for review. Code: `src/app/accounts/record-abuse-strike.ts`.

## What counts as a strike

A request only a hand-written client sends. Today there is one source:

| reason                | where it is raised                                              |
| --------------------- | --------------------------------------------------------------- |
| `invalid-send-amount` | the send guard refuses a zero, negative or malformed amount     |

Add a source by calling `recordAbuseStrike` where the request is refused. Never
add something a real user can do by mistake (wrong PIN, over-limit amount,
mistyped address): the outcome is a locked account.

## Threshold

`rateLimits.abuseStrike` in the values yaml. `points` is the number of strikes
tolerated inside `duration`; the default `{ points: 1, duration: 3600 }` locks
on the second strike within an hour. Keep `blockDuration` equal to `duration`.

## The operator switch

`abuseAutoLock.mode` in the values yaml. Default **`log-only`**. Anything
unrecognised degrades to `log-only`.

| mode       | behaviour                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------- |
| `off`      | Strikes are not counted.                                                                    |
| `log-only` | Crossing the threshold posts a `customer / would-auto-lock` ops event. Nothing is locked.   |
| `enforce`  | The account is locked, its API keys are revoked, and a `customer / auto-locked` event posts. |

The send guard must not be `off`: with the guard off no amount is checked, so no
strike is ever raised.

## Turning it on

1. Deploy in `log-only` and read a week of `would-auto-lock` events. Each one
   should be an account nobody would defend.
2. Set `abuseAutoLock.mode: enforce`, `helm upgrade`, restart the api pods.

## Review and unlock

An auto-locked account carries a status comment that starts with `auto-lock:`
and names the reason. Unlocking is a person's decision, made in the admin panel
like any other lock. The API keys stay revoked after an unlock; the user creates
new ones.
