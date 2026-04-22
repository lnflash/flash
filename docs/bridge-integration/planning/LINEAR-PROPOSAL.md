# Bridge Wallet Integration — Linear Project Proposal

> Proposal to restructure the Bridge Wallet Integration project in Linear,
> based on the rewritten doc set (`docs/bridge-integration` @
> `docs/bridge-integration-rewrite-2026-04-22`). This is a working draft
> for Dread to take into Linear, not a unilateral change.
>
> **Source for every claim** is the spec branch `lnflash/flash:docs/bridge-integration-spec @ 85af420`.

## TL;DR

- **2 existing tickets are already done** — close them with links to the
  fix commits.
- **3 existing tickets need scope tightening** — they're broader than
  the actual remaining work and should be split.
- **13 new tickets are needed** to capture gaps the doc rewrite
  surfaced. The 5 most important block Phase 1 launch.
- **Recommended Phase-1 launch sequence** is given in §4 — it puts the
  deposit pipeline ahead of everything else because today **no US user
  can fund a wallet**.

## 1. Status check on existing tickets

| Ticket | Title (short) | Current state in code | Proposed action |
|---|---|---|---|
| **ENG-272** | Runbook | OPERATIONS.md v0 exists in the rewrite | Re-scope to "drill OPERATIONS.md against staging" (rehearse one playbook end-to-end) and close once exercised. |
| **ENG-273** | Monitoring + alerting | Alert table drafted in WEBHOOKS §6; not wired to PagerDuty | Keep open. Split into 273a "wire alerts to PagerDuty" + 273b "dashboards (Bridge volume / latency / error rate)". |
| **ENG-274** | Sandbox E2E | Not built | Keep open. Add explicit acceptance: each of the 3 webhook handlers + each of the 4 mutations exercised against Bridge sandbox. Block Phase-1 launch on this. |
| **ENG-275** | Push notifications on transfer events | `// TODO` in `transferHandler` | Keep open. Trivial after ENG-296 lands. |
| **ENG-280 / CRIT-1** | Insufficient-balance / amount validation | **DONE** in `BridgeService.initiateWithdrawal` | **Close.** Link to fix commit. Open new ticket for the residual float-precision concern (see §3 new ticket NEW-1). |
| **ENG-281 / CRIT-2** | Cross-account ownership for external accounts | **DONE** at app + DB compound-index level | **Close.** Link to fix commit + index migration. |
| **ENG-285** | Validation hardening | Per-field validation gaps | Keep open. Re-scope around the specific gaps API §8 calls out (UUID / amount / status enum on inputs). |
| **ENG-286** | Circuit breaker around outbound Bridge calls | No retry, no backoff, no breaker | Keep open. Tighten scope to: timeout, exponential backoff w/ jitter, breaker on consecutive 5xx. |
| **ENG-296** | IBEX Ethereum address provisioning + wallet credit | Hard-stops every deposit | Keep open. **This is the #1 launch blocker.** Recommend splitting into 296a "address provisioning" + 296b "wallet credit + push on `/crypto/receive`" so they can ship independently and be QA'd separately. |
| **ENG-343** | ToS-accept + pre-KYC profile mutation | KYC link uses `username \|\| "Flash"` for `full_name` | Keep open. Add explicit acceptance: name + ToS-accept timestamp captured before `bridgeInitiateKyc` is callable. |

## 2. New tickets to file

Numbered NEW-1 through NEW-13. Suggested labels in brackets.

### Launch-blocking (P0 — must land before any US user is enabled)

| # | Title | Why | Source |
|---|---|---|---|
| NEW-1 | **GraphQL payload-shape mismatches across all 4 Bridge mutations + 4 queries** [bug, graphql] | Most response fields resolve to `null` on the wire because service return shapes don't match GraphQL types. Mobile cannot rely on mutation responses. | API §8.1 |
| NEW-2 | **GraphQL error-code differentiation for Bridge errors** [bug, graphql] | All 9 BridgeError subclasses collapse to `INVALID_INPUT` or `UNKNOWN_CLIENT_ERROR` and the mapper overwrites the original message. Mobile cannot distinguish KYC-pending, rate-limit, account-suspended, etc. | API §8.4 |
| NEW-3 | **Withdrawal idempotency key on `bridgeInitiateWithdrawal`** [bug, money] | `BridgeClient.createTransfer` supports `Idempotency-Key`; service never passes one. A retry from the app duplicates the transfer → double debit. | EXEC §11 risk #2, README open work |
| NEW-4 | **Refund handler on `transfer.failed`** [bug, money] | A failed off-ramp leaves the USDT wallet debited with no automated refund. Currently no code path credits back. | LIMITS §5, EXEC §11 risk #3 |

### High-priority (P1 — should ship in Phase 1, can fast-follow if we must)

| # | Title | Why | Source |
|---|---|---|---|
| NEW-5 | **Outbound Bridge HTTP timeout + per-call deadline** [reliability] | `BridgeClient` uses `fetch` with no timeout; a hung Bridge endpoint blocks the request indefinitely. Lighter-weight than the full circuit breaker (ENG-286) and a prerequisite to it. | SECURITY §4, ARCHITECTURE |
| NEW-6 | **KYC tier ceiling distinct error** [graphql, ux] | Today a tier-cap rejection looks identical to a generic transfer rejection. User can't tell they need to upgrade. Depends on Bridge's actual error response shape — coordinate with NEW-2. | LIMITS §4 |
| NEW-7 | **Min-withdrawal floor (USDT)** [product, money] | Without a floor, Bridge fees can exceed principal. Suggested $20; needs Product sign-off. | LIMITS §6, FEES §8 |
| NEW-8 | **Add `fee` / `developerFee` / `fxRate` / `quoteRate` columns to `bridgeWithdrawals`** [schema, finance] | Nothing of Bridge's quote is captured today. Prerequisite to any per-transaction P&L or finance reconciliation. | FEES §6 |
| NEW-9 | **Persist Bridge `fee` from `GET /transfers/:id` response onto withdrawal record** [reconciliation] | Depends on NEW-8. Either run on `transfer.completed` webhook or via a poller. | FEES §6 |

### Operational hardening (P2 — pre-launch ideal, post-launch acceptable)

| # | Title | Why | Source |
|---|---|---|---|
| NEW-10 | **Move `bridge.apiKey` from YAML config to secret store** [security] | Currently lives in `yamlConfig.bridge.apiKey` (file-based, no rotation policy). Should be vault/SOPS/sealed-secret with rotation runbook. | SECURITY §9 |
| NEW-11 | **Webhook public-key rotation policy + automation** [security, ops] | Per-endpoint Bridge public keys are static config. No documented rotation cadence; rotation is a manual deploy. | SECURITY §10 |
| NEW-12 | **Backfill / replay tooling for missed Bridge webhooks** [ops] | Today the only reconciliation path is manual Mongo + Bridge-API querying. We need a script that, given a time range, replays missed events through the handlers. | OPERATIONS §10 |
| NEW-13 | **Schema-level constraint on virtual accounts (one-per-account)** [schema, hygiene] | Mongoose schema doesn't prevent a user from accumulating multiple virtual accounts. App layer assumes one. | OPERATIONS §9.3 |

### Product / commercial follow-ups (not engineering tickets, but should exist somewhere)

| # | Title | Owner |
|---|---|---|
| PROD-A | Pin Bridge per-customer / per-rail / per-API limits in the contract | Eng + Bridge sales |
| PROD-B | Pin Bridge contract fees (per-transfer, per-VA, KYC, failure) | Eng + Bridge sales + Finance |
| PROD-C | Decide Flash markup model (Bridge `developer_fee` vs Flash-side wallet debit vs none) | Product + Finance |
| PROD-D | Decide Flash overlay caps (daily/monthly/velocity/cooldown) | Product + Security |
| PROD-E | Quote/confirmation UX showing Bridge's fee deduction (even if Flash markup is zero) | Product + Mobile |

## 3. Out-of-scope / parking lot

These came up in the docs but are explicitly Phase-2+ and shouldn't pollute the Phase-1 board:

- Wire / SEPA / non-US rails.
- Non-Ethereum settlement (Tron etc.).
- USD-denominated wallet UX (USD lands as USDT today).
- KYC tier-upgrade flows beyond Bridge's defaults.
- Programmatic account suspension / unsuspend.

## 4. Recommended Phase-1 launch sequence

A defensible "ship Phase 1" critical path, in order. Items in the same
row can run in parallel.

| Wave | Tickets | Outcome |
|---|---|---|
| **W1 — unblock the rail** | ENG-296a (address provisioning), ENG-343 (pre-KYC profile) | A US user can KYC and receive a virtual account. |
| **W2 — unblock the deposit** | ENG-296b (wallet credit + push on `/crypto/receive`) | A US user can fund a wallet and see the credit. |
| **W3 — make the withdrawal safe** | NEW-3 (idempotency), NEW-4 (refund), NEW-5 (timeout) | A US user can off-ramp without double-debit or wallet leakage. |
| **W4 — make it usable** | NEW-1 (payload shapes), NEW-2 (error codes), NEW-6 (KYC tier), ENG-275 (push) | The app can show meaningful states to the user. |
| **W5 — make it observable** | ENG-273a (PagerDuty), ENG-274 (sandbox E2E), NEW-12 (replay tooling) | On-call can respond when things break. |
| **W6 — make the books match** | NEW-8, NEW-9, NEW-7 (min-withdrawal floor) | Finance can reconcile per-transaction. |
| **W7 — harden** | ENG-286 (circuit breaker), ENG-285 (validation), NEW-10 (vault), NEW-11 (key rotation), NEW-13 (schema constraint) | Operational hygiene. |

**Hard launch gate:** W1–W5 must be green. W6–W7 can be in-flight at launch.

## 5. Suggested project hygiene in Linear

- **Add a "Doc reference" custom field** on each ticket pointing at the
  doc + section that motivates it (e.g. `API §8.1`). Keeps the
  rationale next to the work.
- **Tag every ticket with one of**: `bug`, `feature`, `reliability`,
  `security`, `ops`, `schema`, `graphql`, `money`, `ux`, `finance`. The
  proposal above already pre-tags.
- **Use the wave numbers (W1–W7) as a milestone** so the launch
  critical path is queryable.
- **Block tickets explicitly**: NEW-9 → blocks-on NEW-8; NEW-6 →
  blocks-on NEW-2; W3 tickets → block-on ENG-296b; W2 → blocks-on W1;
  etc. The wave structure makes this mostly mechanical.
- **Add the EXEC summary § anchor to the project description** so
  anyone landing on the project board sees the 10,000-foot view first.

## 6. What this proposal does *not* touch

- **JM Cashout V1 work** — out of scope for the Bridge integration
  project per FLOWS §6. Should remain on its own project.
- **IBEX general work beyond ENG-296** — IBEX maintenance/new-feature
  tickets unrelated to Bridge belong elsewhere.
- **Flash mobile app changes** unrelated to NEW-1/NEW-2/NEW-6 — those
  belong on the mobile project, not this one.

## Document History

| Date | Author | Change |
|---|---|---|
| 2026-04-22 | Taddesse (Dread review) | Initial proposal derived from the rewritten doc set on `docs/bridge-integration-rewrite-2026-04-22`. |
