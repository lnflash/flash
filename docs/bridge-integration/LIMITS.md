# Bridge.xyz Integration — Limits

> Documents what's actually enforced in code today, what Bridge enforces
> outside Flash, and what's pending decision. **Many values here are TBD**
> until pricing/limits are finalized with Bridge and product.

## 1. What Flash enforces in code today

| Limit | Where | Value | Notes |
|---|---|---|---|
| Account level for any Bridge op | `BridgeService.checkAccountLevel` | `level >= 2` (Pro) | Hard reject below. |
| Bridge feature flag | `BridgeService.checkBridgeEnabled` | `BridgeConfig.enabled === true` | Master kill. |
| KYC must be `"approved"` to create a virtual account | `BridgeService.createVirtualAccount` | enum check | `pending`/`rejected` rejected with specific errors. |
| External account must be `status: "verified"` to withdraw | `BridgeService.initiateWithdrawal` | enum check | Pending links cannot fund a transfer. |
| Caller must own the external account | App-layer scan **+** DB unique compound index `(accountId, bridgeExternalAccountId)` | hard | CRIT-2 / ENG-281. |
| USDT wallet balance ≥ requested amount | `BridgeService.initiateWithdrawal` | float comparison | CRIT-1 / ENG-280. **Float precision concern** — see API §8.3. |
| Withdrawal amount > 0 and not NaN | same | rejects `<=0` and `NaN` | Returns `BridgeInsufficientFundsError`. |
| Webhook timestamp skew | `verify-signature` middleware | `bridge.webhook.timestampSkewMs` (default 300000 = **5 min**) | Replay window. |

There is **no** Flash-side enforcement of:

- Per-account daily / weekly / monthly transfer caps.
- Per-account total deposit caps.
- Velocity limits (number of withdrawals per N hours).
- Cooldown after KYC approval before first withdrawal.
- Minimum deposit / minimum withdrawal amounts.
- Maximum number of linked external accounts.
- Maximum number of virtual accounts (no schema constraint either — see
  OPERATIONS §9.3).

## 2. What Bridge enforces (per Bridge contract — TBD)

> **TBD — verify with Bridge dashboard / contract / sandbox testing.** The
> values below are placeholders to drive a follow-up.

### 2.1 Per-customer (Bridge customer ID)

| Dimension | Bridge limit (TBD) | Flash impact |
|---|---|---|
| Per-transaction USD on-ramp ceiling | TBD | Surfaces as Bridge API error during transfer; user retries with smaller amount. |
| Per-transaction USD off-ramp ceiling | TBD | Same. |
| Daily aggregate (rolling 24h) | TBD | Same. |
| Monthly aggregate (rolling 30d) | TBD | Same. |
| Annual aggregate | TBD | Same. |
| Number of linked external accounts | TBD | Bridge link flow may refuse to create more. |
| KYC tier upgrade thresholds | TBD | Higher tier = higher caps; not modelled in Flash today. |

### 2.2 Per-rail

| Rail | Min | Max | Settlement | Notes |
|---|---|---|---|---|
| ACH push (off-ramp) | TBD | TBD | T+1 to T+3 typical | Phase-1 default off-ramp. |
| Wire | TBD | TBD | same-day | Not exposed in Phase 1. |
| USDT-on-Ethereum (deposit) | TBD | TBD | network confirmations | Must match Bridge's address whitelist. |

### 2.3 Per-API (rate limits)

| Endpoint | Limit | Source |
|---|---|---|
| `POST /transfers` | TBD | Bridge response 429 → `BridgeRateLimitError`. |
| `POST /kyc_links` | TBD | Same. |
| All endpoints (global) | TBD | Same. |

When hit: `BridgeRateLimitError` → wire-level `INVALID_INPUT` /
"Rate limit exceeded, please try again later". **There is no client-side
backoff today** — repeated calls from the same user will keep tripping it.
Tracked under **ENG-286** (circuit breaker).

## 3. Flash overlay — proposed (decisions TBD)

These are the limits that sit *on top of* Bridge's. They protect Flash from
abuse and are the only place we can enforce per-user caps independent of
Bridge's per-customer tiering.

| Decision | Default proposed | Rationale | Owner |
|---|---|---|---|
| Per-account daily withdrawal cap (USD) | TBD — suggest start at $1,000/day | Match the support team's ability to triage incidents manually. | Product |
| Per-account monthly withdrawal cap (USD) | TBD — suggest $10,000/month | Aligns with KYC tier expectations. | Product |
| Minimum withdrawal amount (USDT) | TBD — suggest $20 | Below this, Bridge fees swamp the principal. | Product + Finance |
| Maximum number of linked external accounts per Flash account | TBD — suggest 5 | Operational hygiene. | Product |
| Cooldown between linking and first withdrawal (hours) | TBD — suggest 24h | Anti-takeover defence. | Security |
| Velocity cap (withdrawals per 24h) | TBD — suggest 5 | Anti-automation. | Security |

**None of these are implemented today.** Each requires a service-layer
guard in `BridgeService.initiateWithdrawal` and a corresponding GraphQL
error class. Work is unscoped pending product sign-off.

## 4. Behavior when limits are hit

| Limit type | Surface | UX implication |
|---|---|---|
| Flash-enforced (e.g. balance) | `INVALID_INPUT` / "Insufficient funds for withdrawal" | Show available balance; allow retry with smaller amount. |
| Bridge-enforced (per-tx) | `INVALID_INPUT` / passthrough Bridge message (or `UNKNOWN_CLIENT_ERROR`) | Show generic "transfer rejected"; no clean retry UX. |
| Bridge-enforced (rate limit 429) | `INVALID_INPUT` / "Rate limit exceeded, please try again later" | Same — needs backoff. |
| Bridge-enforced (account suspended) | `UNKNOWN_CLIENT_ERROR` | Manual intervention. Operator must contact Bridge. |
| KYC tier ceiling | Same as per-tx — no distinction at the wire today | User can't tell they need to upgrade KYC. **Gap**. |

## 5. Reconciliation expectations

- **Bridge balance vs Flash record:** must match for `bridgeWithdrawals.amount`
  in `pending` + `completed` states. A `failed` state should refund the
  user's USDT wallet — **this refund is not yet implemented anywhere in the
  visible code**. Likely follow-up under ENG-296 / a new ticket.
- **USDT balance vs IBEX:** governed by IBEX, not Bridge. Out of scope here.

## 6. Open work

| Item | Owner | Tracking |
|---|---|---|
| Pin Bridge per-customer / per-rail / rate-limit numbers | Eng + Bridge support | (new ticket) |
| Implement Flash overlay caps | Eng (after product) | (new ticket) |
| Surface KYC tier ceiling distinctly from generic rejection | Eng + Bridge | (new ticket — depends on Bridge error response shape) |
| Refund flow on `transfer.failed` | Eng | (new ticket — likely under ENG-296) |
| Backoff / circuit breaker for 429 | Eng | **ENG-286** |
| Min-withdrawal floor (so Bridge fees don't swamp principal) | Product → Eng | (new ticket) |

## Document History

| Date | Author | Change |
|---|---|---|
| 2026-04-22 | Taddesse (Dread review) | Initial limits doc; honestly labels TBDs and Flash-vs-Bridge enforcement boundary. |
