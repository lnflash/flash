# Bridge.xyz GraphQL API Reference

> **Status:** This document describes the Bridge GraphQL API as it exists on
> branch `docs/bridge-integration-spec` (HEAD `85af420`). Every signature,
> field name, and error class below is grounded in source code at
> `src/graphql/public/root/{mutation,query}/bridge-*.ts`,
> `src/graphql/public/types/object/bridge-*.ts`, and
> `src/services/bridge/{index,errors}.ts`. Where the schema is provably
> broken (Section 8 — payload-shape mismatches), the doc reports the schema as
> written, then calls out the bug.

---

## 1. Purpose & Scope

This document covers the **public GraphQL surface** for Bridge.xyz USD on/off-ramp
operations: KYC, virtual-account provisioning, external-account linking, and
withdrawals. It does **not** cover:

- The internal `BridgeService` API (see `src/services/bridge/index.ts`).
- The Bridge HTTP client (`src/services/bridge/client.ts`).
- The webhook server (see `WEBHOOKS.md`).
- The IBEX `/crypto/receive` ingestion path (see `WEBHOOKS.md` §4).

Audience: mobile clients, integration partners, internal tooling.

---

## 2. Preconditions

Every Bridge operation enforces, **in this order**:

1. **`BridgeConfig.enabled === true`** — global feature flag in YAML config
   (`bridge.enabled`). When false, every operation short-circuits with
   `BridgeDisabledError`.
2. **Authenticated context** — resolvers require `domainAccount` from
   `GraphQLPublicContextAuth`. Mutations treat a missing account as a level
   failure (returns `BridgeAccountLevelError`); queries return `null`.
3. **Account level ≥ 2** — `domainAccount.level < 2` returns
   `BridgeAccountLevelError`.

The service layer re-runs (1) and (2) defensively. If a future caller invokes
the service outside GraphQL, the same guards apply.

> **Note on KYC gating:** Each operation has its own KYC requirements (see
> per-operation sections). `bridgeAddExternalAccount` does **not** currently
> require approved KYC at the service layer; the others do.

---

## 3. Response Conventions

### 3.1 Mutations

All four mutations return a payload of the shape:

```graphql
type <Operation>Payload {
  errors: [Error!]
  <field>: <Type>
}
```

Mutations **never throw** — failures populate `errors` and leave the data field
`null`. Each error object follows Flash's standard shape produced by
`mapAndParseErrorForGqlResponse`:

```graphql
type Error {
  code: String      # one of "INVALID_INPUT" or "UNKNOWN_CLIENT_ERROR" for Bridge
  message: String
  path: [String]
}
```

> **Important:** All Bridge `BridgeError` subclasses are funnelled through
> `src/graphql/error-map.ts` into one of just two `CustomApolloError` codes —
> `INVALID_INPUT` (via `ValidationInternalError`) for nearly all of them,
> `UNKNOWN_CLIENT_ERROR` (via `UnknownClientError`) for the generic
> `BridgeApiError`/`BridgeError` catch-all. **The `message` string is the
> only field that distinguishes one Bridge failure mode from another.** See
> §7 for the full mapping and §8.5 for the design issue this raises.

### 3.2 Queries

The four queries do **not** use the envelope pattern. They:

- Return `null` if `domainAccount` is missing.
- **`throw` (via `mapAndParseErrorForGqlResponse`)** when `BridgeConfig.enabled
  === false` or when the underlying service returns an `Error`. Errors surface
  in the standard GraphQL `errors` array on the response.

This asymmetry is consistent with other Flash GraphQL operations but worth
noting for client implementors.

---

## 4. Mutations

### 4.1 `bridgeInitiateKyc`

Starts (or resumes) the KYC flow for the authenticated account. Idempotent:
re-invocation reuses the existing Bridge customer and returns the latest valid
KYC link unless the prior link was rejected/offboarded, in which case a fresh
link is issued.

**Signature**

```graphql
extend type Mutation {
  bridgeInitiateKyc: BridgeInitiateKycPayload!
}

type BridgeInitiateKycPayload {
  errors: [Error!]
  kycLink: BridgeKycLink
}

type BridgeKycLink {
  kycLink: String!
  tosLink: String!
}
```

**Behavior** (`BridgeService.initiateKyc`)

1. Looks up `account.bridgeCustomerId`. If absent, fetches the user's email from
   Kratos and calls `BridgeClient.createKycLink(...)` with
   `type: "individual"`, `email`, `full_name = account.username || "Flash"`,
   then persists the new `bridgeCustomerId` and `bridgeKycStatus: "not_started"`.
2. Calls `BridgeClient.getLatestKycLink(customerId)`. If the latest link's
   status is **not** `"rejected"` or `"offboarded"`, returns it.
3. Otherwise issues a fresh KYC link and returns that.

**Errors** (all surface as `INVALID_INPUT` unless noted; see §7 for full
mapping): "Bridge integration is currently disabled", "Bridge requires Pro
account (Level 2+)", "Rate limit exceeded, please try again later",
"Request timed out". Any other Bridge-API failure surfaces as
`UNKNOWN_CLIENT_ERROR`. A generic server error is returned if the user has no
email on their Kratos identity.

**Idempotency:** Effectively idempotent across retries (reuses customer +
latest valid link). No client-supplied idempotency key.

**Gaps**

- Hardcodes `type: "individual"` at the GraphQL layer; the service supports
  `"business"` but it is not exposed.
- `full_name` falls back to the literal string `"Flash"` if the account has no
  username — a side effect of pre-KYC profile fields not yet being collected
  (**ENG-343**).
- The service returns `kycStatus` in addition to `kycLink`/`tosLink`, but the
  GraphQL type does not expose it. Clients must call `bridgeKycStatus`
  separately.

---

### 4.2 `bridgeCreateVirtualAccount`

Provisions a USD-denominated virtual bank account that funnels deposits to the
account's IBEX-managed Ethereum USDT receive address.

**Signature**

```graphql
extend type Mutation {
  bridgeCreateVirtualAccount: BridgeCreateVirtualAccountPayload!
}

type BridgeCreateVirtualAccountPayload {
  errors: [Error!]
  virtualAccount: BridgeVirtualAccount
}

type BridgeVirtualAccount {
  id: ID!
  bankName: String!
  routingNumber: String!
  accountNumberLast4: String!
}
```

**Behavior** (`BridgeService.createVirtualAccount`)

1. Requires `account.bridgeCustomerId` (returns `BRIDGE_CUSTOMER_NOT_FOUND`
   otherwise).
2. Requires `account.bridgeKycStatus === "approved"`. `"pending"` →
   `BRIDGE_KYC_PENDING`. `"rejected"` → `BRIDGE_KYC_REJECTED`. Any other value
   → `BRIDGE_KYC_PENDING` with message "KYC not yet completed".
3. Requires `account.bridgeEthereumAddress`. **Currently always returns a
   generic `Error("IBEX Ethereum address creation not yet implemented")`**
   when missing — IBEX integration is unbuilt (**ENG-296**).
4. Calls `BridgeClient.createVirtualAccount(customerId, { source: { currency:
   "usd" }, destination: { currency: "usdt", payment_rail: "ethereum",
   address: ethereumAddress } })`.
5. Persists the result via `BridgeAccountsRepo.createVirtualAccount`.

**Errors** (all `INVALID_INPUT` unless noted; see §7): "Bridge integration is
currently disabled", "Bridge requires Pro account (Level 2+)", "Bridge
customer not found", "KYC verification is pending", "KYC verification was
rejected", plus a generic server error when the Ethereum address is missing
("IBEX Ethereum address creation not yet implemented"). Other Bridge-API
failures surface as `UNKNOWN_CLIENT_ERROR`.

**Idempotency:** None at the GraphQL layer. Calling twice in succession will
attempt to create a second virtual account. There is no DB uniqueness
constraint surfaced in the doc (TODO: confirm in `bridgeVirtualAccounts`
schema).

**Gaps**

- See §8 — the resolver returns the service's `{ virtualAccountId, bankName,
  ... }` shape as `virtualAccount`, but the GraphQL type expects field `id`,
  not `virtualAccountId`. **`virtualAccount.id` will resolve to `null`.**
- No idempotency key.
- No support for currencies other than USD-source / USDT-on-Ethereum
  destination.

---

### 4.3 `bridgeAddExternalAccount`

Issues a **Bridge-hosted bank-link URL** (Plaid-driven) for the user to
connect an external bank account. The user completes the link in a hosted
page; verification status flows back via the deposit/transfer webhook stream
and shows up later in `bridgeExternalAccounts`.

> **Important — read the gaps section.** The current GraphQL type does not
> match the service return shape, so this mutation as wired is broken.

**Signature**

```graphql
extend type Mutation {
  bridgeAddExternalAccount: BridgeAddExternalAccountPayload!
}

type BridgeAddExternalAccountPayload {
  errors: [Error!]
  externalAccount: BridgeExternalAccount
}

type BridgeExternalAccount {
  id: ID!
  bankName: String!
  accountNumberLast4: String!
  status: String!
}
```

**Behavior** (`BridgeService.addExternalAccount`)

1. Requires `account.bridgeCustomerId` (returns `BRIDGE_CUSTOMER_NOT_FOUND`
   otherwise).
2. **Does not check KYC status** — by design, allows users to start the
   bank-link flow before/during KYC.
3. Calls `BridgeClient.getExternalAccountLinkUrl(customerId)`.
4. Returns `{ linkUrl: string, expiresAt: string }`.

**Errors** (all `INVALID_INPUT`; see §7): "Bridge integration is currently
disabled", "Bridge requires Pro account (Level 2+)", "Bridge customer not
found". Other Bridge-API failures surface as `UNKNOWN_CLIENT_ERROR`.

**Idempotency:** None. Each call mints a new short-lived link URL.

**Gaps — payload shape mismatch (BUG)**

- The service returns `{ linkUrl, expiresAt }`.
- The GraphQL type `BridgeExternalAccount` exposes `id, bankName,
  accountNumberLast4, status`.
- **None of the four exposed fields exist on the service result.** Every
  field will resolve to `null`. Clients cannot consume this mutation as
  currently shipped.
- Resolution will require either (a) a separate `BridgeExternalAccountLink`
  type with `linkUrl`/`expiresAt`, or (b) a different mutation that returns
  the persisted account *after* link completion. See §8.

---

### 4.4 `bridgeInitiateWithdrawal`

Initiates a USDT (Ethereum) → USD (ACH) transfer from the account's IBEX
Ethereum address to a previously-linked, verified external account.

**Signature**

```graphql
extend type Mutation {
  bridgeInitiateWithdrawal(
    input: BridgeInitiateWithdrawalInput!
  ): BridgeInitiateWithdrawalPayload!
}

input BridgeInitiateWithdrawalInput {
  amount: String!
  externalAccountId: ID!
}

type BridgeInitiateWithdrawalPayload {
  errors: [Error!]
  withdrawal: BridgeWithdrawal
}

type BridgeWithdrawal {
  id: ID!
  amount: String!
  currency: String!
  status: String!
  createdAt: String!
}
```

**Behavior** (`BridgeService.initiateWithdrawal`)

1. Requires `account.bridgeCustomerId`.
2. Requires `account.bridgeEthereumAddress`.
3. **CRIT-1 (ENG-280)** Loads the account's USDT wallet, fetches its balance,
   parses `amount` as float, rejects with `BRIDGE_INSUFFICIENT_FUNDS` if
   `amount <= 0`, NaN, or greater than available balance.
4. **CRIT-2 (ENG-281)** Loads `BridgeAccountsRepo.findExternalAccountsByAccountId`
   and verifies the supplied `externalAccountId` belongs to the caller. Returns
   a generic `Error("External account not found")` whether the account doesn't
   exist or belongs to another user (no existence-leak). Compound index
   `(accountId, bridgeExternalAccountId)` enforces this at the DB level too —
   see `ARCHITECTURE.md` §6.
5. Requires the external account `status === "verified"`.
6. Calls `BridgeClient.createTransfer(customerId, { amount, on_behalf_of:
   customerId, source: { payment_rail: "ethereum", currency: "usdt",
   from_address: ethereumAddress }, destination: { payment_rail: "ach",
   currency: "usd", external_account_id: externalAccountId } })`.
7. Persists the withdrawal as `status: "pending"` via
   `BridgeAccountsRepo.createWithdrawal`. The `transferHandler` webhook later
   flips this to `completed` or `failed` (see `WEBHOOKS.md` §3.3).

**Errors** (all `INVALID_INPUT` unless noted; see §7): "Bridge integration is
currently disabled", "Bridge requires Pro account (Level 2+)", "Bridge
customer not found", "Insufficient funds for withdrawal" (also fires on NaN /
≤ 0 amount), plus generic server errors for "External account not found",
"External account is not verified", and the missing-Ethereum-address
fallback. Other Bridge-API failures surface as `UNKNOWN_CLIENT_ERROR`.

**Idempotency:** None at the GraphQL layer. **A retry with the same input
will create a second transfer.** Clients must deduplicate on their side until
ENG-XXX adds a per-input idempotency key.

**Gaps**

- See §8 — `withdrawal.id` resolves to `null` (service returns `transferId`),
  and `withdrawal.status` resolves to `null` (service returns `state`).
- `amount: String` is house-style-inconsistent (Flash uses `MoneyAmount`
  elsewhere); float parsing here means amounts are rounded to IEEE-754
  precision before balance comparison. ENG-XXX recommended.
- No idempotency key.
- `currency` on `BridgeWithdrawal` is unused for ETH-only Phase-1 — always
  `"usd"`. Remove or document scope.

---

## 5. Queries

### 5.1 `bridgeKycStatus`

```graphql
extend type Query {
  bridgeKycStatus: String
}
```

**Returns:** the value of `account.bridgeKycStatus` (or `null`). The service
typechecks the result against `"pending" | "approved" | "rejected" | null`,
but the field is **typed as `String`** — clients cannot rely on enum
exhaustiveness.

**Behavior:** Returns `null` if `domainAccount` is missing. Throws
`BRIDGE_DISABLED` if Bridge is off.

**Errors** (thrown, not in envelope): `INVALID_INPUT` /
"Bridge integration is currently disabled",
`INVALID_INPUT` / "Bridge requires Pro account (Level 2+)".

**Gaps:** Should be a `BridgeKycStatus` enum.

---

### 5.2 `bridgeVirtualAccount`

```graphql
extend type Query {
  bridgeVirtualAccount: BridgeVirtualAccount
}
```

**Returns:** The user's virtual account, or `null` if none exists.

**Behavior:** Calls `BridgeAccountsRepo.findVirtualAccountByAccountId`.
A `RepositoryError` from "not found" is normalized to `null`. Other repo
errors throw.

**Errors** (thrown, not in envelope): `INVALID_INPUT` /
"Bridge integration is currently disabled",
`INVALID_INPUT` / "Bridge requires Pro account (Level 2+)".

**Gaps:** Same shape mismatch as §4.2 — service returns
`{ bridgeVirtualAccountId, ... }`, type exposes `id`. **`id` resolves to
`null`.** See §8.

---

### 5.3 `bridgeExternalAccounts`

```graphql
extend type Query {
  bridgeExternalAccounts: [BridgeExternalAccount]
}
```

**Returns:** All linked external accounts for the caller.

**Behavior:** Calls `BridgeAccountsRepo.findExternalAccountsByAccountId` and
maps each to `{ bridgeExternalAccountId, bankName, accountNumberLast4,
status }`.

**Errors** (thrown, not in envelope): `INVALID_INPUT` /
"Bridge integration is currently disabled". (Note: the resolver does not
re-check `account.level`, so a level-1 caller with a non-null `domainAccount`
can still hit this query — the service-layer `checkAccountLevel` will fire
the same `INVALID_INPUT` / "Bridge requires Pro account (Level 2+)".)

**Gaps:** Same shape mismatch as §4.3 — service returns
`bridgeExternalAccountId`, type exposes `id`. **`id` resolves to `null` on
every row.** See §8.

---

### 5.4 `bridgeWithdrawals`

```graphql
extend type Query {
  bridgeWithdrawals: [BridgeWithdrawal]
}
```

**Returns:** All withdrawals for the caller, mapped to `{ transferId,
amount, currency, state, createdAt }` by the service.

**Behavior:** Calls `BridgeAccountsRepo.findWithdrawalsByAccountId`. No
pagination, no filtering, no ordering guarantees beyond repository default.

**Errors** (thrown, not in envelope): `INVALID_INPUT` /
"Bridge integration is currently disabled". Same level-check caveat as §5.3.

**Gaps:** Same shape mismatch as §4.4 — service returns `transferId` and
`state`; type exposes `id` and `status`. **Both fields resolve to `null` on
every row.** No `bridgeWithdrawalById(id: ID!)` query exists; clients must
fetch the whole list. See §8.

---

## 6. Type Reference

```graphql
type BridgeKycLink {
  kycLink: String!
  tosLink: String!
}

type BridgeVirtualAccount {
  id: ID!
  bankName: String!
  routingNumber: String!
  accountNumberLast4: String!
}

type BridgeExternalAccount {
  id: ID!
  bankName: String!
  accountNumberLast4: String!
  status: String!
}

type BridgeWithdrawal {
  id: ID!
  amount: String!
  currency: String!
  status: String!
  createdAt: String!
}

input BridgeInitiateWithdrawalInput {
  amount: String!
  externalAccountId: ID!
}
```

Branded-ID primitives (TypeScript-only, not exposed on the wire):
`BridgeCustomerId`, `BridgeVirtualAccountId`, `BridgeExternalAccountId`,
`BridgeTransferId` (see `src/domain/primitives/bridge.ts`).

---

## 7. Error Catalogue

All Bridge errors extend `BridgeError extends DomainError` with
`level: ErrorLevel.Warn`. The error-map at `src/graphql/error-map.ts`
collapses every `BridgeError` subclass into one of two `CustomApolloError`
codes. The table below shows the **wire-level `code`**, the **canonical
`message`** the mapper substitutes (overwriting the original), the
underlying domain class, and what triggers it.

| Wire `code` | Wire `message` (set by mapper) | Domain class | Trigger | Client guidance |
|---|---|---|---|---|
| `INVALID_INPUT` | `Bridge integration is currently disabled` | `BridgeDisabledError` | `BridgeConfig.enabled === false`. | Treat the entire Bridge feature as off. Hide UI. |
| `INVALID_INPUT` | `Bridge requires Pro account (Level 2+)` | `BridgeAccountLevelError` | `account.level < 2`. | Direct user to upgrade to Pro. |
| `INVALID_INPUT` | `Bridge customer not found` | `BridgeCustomerNotFoundError` | No `bridgeCustomerId` on account, **or** Bridge API returned 404. | Run `bridgeInitiateKyc` first. |
| `INVALID_INPUT` | `KYC verification is pending` | `BridgeKycPendingError` | `bridgeKycStatus === "pending"` or any non-approved value. | Poll `bridgeKycStatus` or wait for `kyc.approved` webhook. |
| `INVALID_INPUT` | `KYC verification was rejected` | `BridgeKycRejectedError` | `bridgeKycStatus === "rejected"`. | Show rejection messaging; offer retry via `bridgeInitiateKyc`. |
| `INVALID_INPUT` | `Insufficient funds for withdrawal` | `BridgeInsufficientFundsError` | USDT wallet balance < requested amount, or invalid `amount`. | Show available balance; let user reduce amount. |
| `INVALID_INPUT` | `Rate limit exceeded, please try again later` | `BridgeRateLimitError` | Bridge API returned 429. | Backoff + retry. |
| `INVALID_INPUT` | `Request timed out` | `BridgeTimeoutError` | Bridge API returned 408, or client timed out. | Retry **only** for read operations and KYC; **do not retry `bridgeInitiateWithdrawal`** until idempotency is added (§8.3). |
| `UNKNOWN_CLIENT_ERROR` | *(passes through `error.message` or `"Bridge API error"`)* | `BridgeApiError` | Any other non-2xx from Bridge. `statusCode` and `response` are logged but not exposed. | Surface generic error; log for ops. |
| `UNKNOWN_CLIENT_ERROR` | *(passes through `error.message`)* | `BridgeError` (base, unmapped subclass) | Catch-all. | Same as above. |
| *(generic `Error` — likely surfaces as `INTERNAL_SERVER_ERROR`)* | varies | `Error` (service-layer fallthrough) | Missing email, no Ethereum address, "External account not found", "External account is not verified", "IBEX Ethereum address creation not yet implemented". | Treat as unrecoverable; show generic failure messaging. |

`BridgeWebhookValidationError` is mapped (`INVALID_INPUT`,
`"Invalid webhook signature"`) but is server-side only and never appears in a
public GraphQL response.

> **Identifying a specific Bridge error on the client requires string-matching
> on `message`** — the `code` field is not discriminating. See §8.5.

---

## 8. Known Gaps & Planned Work

### 8.1 Payload-shape mismatches (BUG class — blocks every Bridge operation)

Every Bridge GraphQL type has at least one field name that does not match the
service-layer return shape. Every mismatched field resolves to `null` at
query time. **Until these are reconciled, the API surface is functionally
broken in any environment where Bridge is enabled.**

| GraphQL field | Service field | Operation(s) affected | Symptom |
|---|---|---|---|
| `BridgeVirtualAccount.id` | `virtualAccountId` (create) / `bridgeVirtualAccountId` (query) | `bridgeCreateVirtualAccount`, `bridgeVirtualAccount` | `id` is always `null` |
| `BridgeExternalAccount.id` | `bridgeExternalAccountId` | `bridgeExternalAccounts` | `id` is always `null` |
| `BridgeExternalAccount.{bankName,accountNumberLast4,status}` | n/a — service returns `{ linkUrl, expiresAt }` for `addExternalAccount` | `bridgeAddExternalAccount` | All four fields `null`; `linkUrl` not exposed at all |
| `BridgeWithdrawal.id` | `transferId` | `bridgeInitiateWithdrawal`, `bridgeWithdrawals` | `id` is always `null` |
| `BridgeWithdrawal.status` | `state` | `bridgeInitiateWithdrawal`, `bridgeWithdrawals` | `status` is always `null` |

Fix options (per type):
- **Quick:** rename GraphQL fields to match service (`id` → `bridgeXId`,
  `status` → `state`).
- **Better:** rename service fields to match GraphQL (`virtualAccountId` →
  `id`, etc.) and let the resolver pass through.
- **`bridgeAddExternalAccount` specifically** needs a separate
  `BridgeExternalAccountLink { linkUrl: String!, expiresAt: String! }` type.

### 8.2 Missing operations

| Op | Why it's needed | Tracking |
|---|---|---|
| `bridgeRemoveExternalAccount(id: ID!)` | Users have no way to delete a stale linked bank. | New ticket TBD |
| `bridgeWithdrawalById(id: ID!)` | Polling individual transfers without re-fetching the entire list. | New ticket TBD |
| ToS-acceptance mutation | Bridge requires the user to accept ToS as part of customer creation; currently inferred but never explicitly recorded. | **ENG-343** |
| Pre-KYC profile-collection mutation | `initiateKyc` falls back to `account.username \|\| "Flash"` for `full_name`; we should collect first/last name, DOB, address before issuing the KYC link. | **ENG-343** |

### 8.3 Type / contract issues

| Issue | Recommendation | Tracking |
|---|---|---|
| `bridgeKycStatus: String` | Convert to `BridgeKycStatus` enum (`PENDING`, `APPROVED`, `REJECTED`, `NOT_STARTED`). | New ticket TBD |
| `BridgeWithdrawal.status: String` | Convert to enum (`PENDING`, `COMPLETED`, `FAILED`). | New ticket TBD |
| `BridgeInitiateWithdrawalInput.amount: String` | Convert to `MoneyAmount` to match Flash house style and avoid float parsing in service. | New ticket TBD |
| No idempotency key on `bridgeInitiateWithdrawal` | Add `clientIdempotencyKey: String` to input; service should hash + dedupe via `LockService`. | New ticket TBD |
| `bridgeInitiateKyc` hardcodes `type: "individual"` | Expose optional `type: BridgeKycType` input. | Lower priority |

### 8.4 Error-code collapse (client-side discrimination is broken)

`src/graphql/error-map.ts` maps **9 of the 10** `BridgeError` subclasses to
the same `INVALID_INPUT` code. The 10th (`BridgeApiError`) and the base
class (`BridgeError`) both map to `UNKNOWN_CLIENT_ERROR`. Consequences:

- A client receiving `INVALID_INPUT` cannot programmatically tell whether
  the user needs to upgrade (`BridgeAccountLevelError`), wait
  (`BridgeKycPendingError`), retry (`BridgeRateLimitError` /
  `BridgeTimeoutError`), enter a different amount
  (`BridgeInsufficientFundsError`), or stop entirely
  (`BridgeKycRejectedError` / `BridgeDisabledError`).
- The error mapper **overwrites the original `message` with a hard-coded
  English string**, so any localization or contextual info from the service
  (e.g. `"Insufficient USDT balance: available 12.34, requested 50.00"`) is
  lost on the wire — the client sees only `"Insufficient funds for
  withdrawal"`.

Recommended fix: introduce per-class codes (`BRIDGE_DISABLED`,
`BRIDGE_KYC_PENDING`, etc.) by adding a new `BridgeError`-aware case in the
error-map that preserves the class name and the original message. Tracking:
new ticket TBD.

### 8.5 Behavioral gaps

| Gap | Notes | Tracking |
|---|---|---|
| `createVirtualAccount` errors with "IBEX Ethereum address creation not yet implemented" | Blocks the entire deposit flow. | **ENG-296** |
| `bridgeAddExternalAccount` does not require KYC | Decision; document explicitly so clients don't gate UI on `bridgeKycStatus`. | None |
| No DB uniqueness constraint surfaced for one-virtual-account-per-user | Repeat calls would produce duplicate Bridge virtual accounts. | TBD — verify schema |
| Float-precision in withdrawal balance check | `parseFloat` on amount + balance loses precision at high values. | Tied to `MoneyAmount` migration above |

---

## 9. Document History

| Date | Author | Change |
|---|---|---|
| 2026-04-21 | Taddesse (Dread review) | Full rewrite grounded in resolver + service source on `docs/bridge-integration-spec @ 85af420`. Documented payload-shape mismatch bug class (§8.1) and error-code-collapse design issue (§8.4) after pinning real codes against `src/graphql/error-map.ts`. |
| (prior) | — | Original API.md committed with branch. |
