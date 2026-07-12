# API Keys — Developer Guide

How to create and use a Flash API key against the public GraphQL API.

> All examples target the local dev endpoint `http://localhost:4002/graphql` (the oathkeeper proxy). In staging/production, substitute the deployed API host.

## 1. Create a key

Key management requires a **logged-in user session** (a Kratos session — see the login flow in [`spectaql/TUTORIAL.md`](../../spectaql/TUTORIAL.md)). You cannot create a key with another API key.

```graphql
mutation ApiKeyCreate {
  apiKeyCreate(
    input: {
      name: "BTCPayServer Integration"
      scopes: [read_wallet, write_wallet, read_transactions]
      expiresIn: 7776000        # optional: seconds until expiry (90 days). Omit = never expires.
      rateLimitPerMinute: 300   # optional: per-key req/min. Omit = platform default.
    }
  ) {
    errors {
      message
    }
    apiKey {
      id
      keyId
      name
      apiKey        # the raw fk_… string — SHOWN ONCE
      scopes
      rateLimitPerMinute
      expiresAt
      warning
    }
  }
}
```

> **GraphQL enum names use underscores.** The `ApiKeyScope` enum values in a query are `read_wallet`, `write_wallet`, `read_transactions`, `write_transactions`, `read_user`, `write_user`, `admin`. Their canonical FIP-07 form (`read:wallet`, …) is what appears in scope error messages and on the wire to the gateway.

**Response** — the `apiKey.apiKey` field holds the full `fk_{keyId}_{secret}` string. It is returned only here. Store it in your secret manager immediately; Flash cannot show it again. `warning` restates this.

Defaults and limits:
- `scopes` defaults to `[read_user]` if omitted.
- `rateLimitPerMinute`, if set, must be `1`–`10000`.
- An account may hold a bounded number of keys (platform default **10**); exceeding it returns `Maximum number of API keys (N) reached…`.

## 2. Authenticate requests

Send the raw key in the **`X-API-KEY`** header on `POST /graphql`. Do **not** use `Authorization` (that header is reserved for Kratos sessions).

```bash
curl -X POST http://localhost:4002/graphql \
  -H "Content-Type: application/json" \
  -H "X-API-KEY: fk_1a2b3c4d_<secret>" \
  -d '{"query":"{ me { defaultAccount { wallets { walletCurrency balance } } } }"}'
```

A valid key resolves to its owning account, exactly as a session would — subject to the key's scopes.

## 3. Scopes

Scopes are enforced **deny-by-default**: an API key may only reach operations explicitly granted to its scopes, and a set of operations is never available to keys at all.

| Scope | Grants (representative operations) |
|---|---|
| `read:user` | `me` and profile/account reads |
| `write:user` | profile mutations — `userUpdateUsername`, `userUpdateLanguage`, `accountUpdateDefaultWalletId`, `accountUpdateDisplayCurrency`, notification settings |
| `read:wallet` | wallet balances and fee estimates — wallet `balance`/`pendingIncomingBalance`, `onChainTxFee`, `ln*InvoiceFeeProbe`, on-chain address reads |
| `write:wallet` | money movement and invoicing — `lnInvoiceCreate`, `lnInvoicePaymentSend`, `intraLedgerPaymentSend`, `onChainPaymentSend`, `lnurlPaymentSend`, etc. |
| `read:transactions` | transaction history — `transactionDetails`, wallet `transactions`/`transactionsByAddress`, contact `transactions`/`transactionsCount`, CSV export |
| `write:transactions` | reserved for transaction-creating operations |
| `admin` | all of the above |

Two implication rules apply:

- **`write:X` implies `read:X`** — a key with `write:wallet` can also perform `read:wallet` operations.
- **`admin` implies every scope.**

**Never available to API keys**, regardless of scope: login/identity (`userLogin*`, email/phone/TOTP registration and deletion), device notification tokens, KYC and Bridge fiat rails, cashout, account deletion, feedback, and **API-key management itself**. These require a user session.

Nested data is guarded too: `me` only needs `read:user`, but reaching wallet balances or transactions through it additionally requires `read:wallet` / `read:transactions` respectively — a `read:user`-only key cannot escalate to financial data.

## 4. Rate limiting

Every key has a requests-per-minute budget (its `rateLimitPerMinute`, or the platform default). When the budget is exhausted the request is rejected before it runs, and the response is a standard GraphQL error with `extensions.code = TOO_MANY_REQUESTS` and the retry metadata inline (HTTP status stays `200`, as it does for every GraphQL error):

```json
{
  "data": null,
  "errors": [
    {
      "message": "API key rate limit exceeded",
      "extensions": {
        "code": "TOO_MANY_REQUESTS",
        "retryAfterSeconds": 42,
        "rateLimit": { "limit": 300, "remaining": 0 }
      }
    }
  ]
}
```

Clients should branch on `errors[].extensions.code === "TOO_MANY_REQUESTS"` and back off for `retryAfterSeconds`. The public API is served through the Apollo federation router, which forwards subgraph GraphQL errors but not subgraph HTTP status codes or response headers — so the machine-readable signal lives in the error `extensions`, not in a `429` status or `X-RateLimit-*` / `Retry-After` headers. (Those headers are still set best-effort on the backend response and are visible only to callers that reach the API service directly, bypassing the router.)

## 5. IP constraints

A key may be pinned to specific source IPs or CIDR ranges (single IPs like `203.0.113.7` or ranges like `10.0.0.0/8`; IPv4 and IPv6, including IPv4-mapped IPv6). A request from any other address is rejected. Enforcement is **fail-closed**: if the source IP cannot be determined, an IP-constrained key is denied. Keys with no constraints are reachable from anywhere.

## 6. Expiry

If `expiresIn` was set, the key stops authenticating once past its expiry and reports `status: EXPIRED` in the key list (even before any stored state is updated). Requests with an expired key are rejected at the gateway.

## 7. List, rotate, revoke

All three require a **user session** (not an API key).

**List** — never returns secret material:

```graphql
query ApiKeys {
  apiKeys {
    id
    keyId
    name
    scopes
    rateLimitPerMinute
    status          # ACTIVE | REVOKED | EXPIRED
    lastUsedAt
    expiresAt
    createdAt
  }
}
```

**Rotate** — issues a replacement (new `keyId` + secret) carrying the **same** name, scopes, IP constraints, rate limit, and expiry, and revokes the old key. The new raw key is returned once:

```graphql
mutation ApiKeyRotate {
  apiKeyRotate(input: { id: "<api-key-id>" }) {
    errors { message }
    apiKey { keyId apiKey scopes expiresAt warning }   # apiKey = new raw fk_… string
  }
}
```

**Revoke** — irreversibly disables the key; verification stops honoring it on the next request:

```graphql
mutation ApiKeyRevoke {
  apiKeyRevoke(input: { id: "<api-key-id>" }) {
    errors { message }
    apiKey { keyId status }   # status = REVOKED
  }
}
```

Both rotate and revoke are scoped to the caller's own account — a key id belonging to another account reads as not-found.

## Error reference

API keys surface two error channels.

**GraphQL errors** (in the response `errors` array, or a mutation's `errors { message }`):

| Situation | Message |
|---|---|
| Key lacks the required scope | `API key missing required scope: <scope>` |
| Operation not available to keys | `API keys cannot access <field>` |
| Management attempted with a key | `API keys cannot be managed while authenticated with an API key` |
| Key expired | `This API key has expired` |
| Source IP not allowed | `API key not allowed from this IP` |
| Invalid name / scope / IP / rate-limit input on create | the specific validation message |
| Per-account key cap reached | `Maximum number of API keys (N) reached. Please revoke unused keys.` |

**Gateway-level response** (before GraphQL runs):

| Situation | Response |
|---|---|
| Missing / malformed / unknown / revoked / expired / IP-rejected key | `401` `{ "error": "invalid_api_key" }` |

A malformed, unknown, revoked, expired, or IP-rejected key produces a gateway `401` — indistinguishable to the caller (by design, to avoid leaking which keys exist). Once a key authenticates, everything else (scope denials, rate limiting, validation) comes back as a GraphQL error with an `extensions.code`, not an HTTP status — the rate-limit case is `TOO_MANY_REQUESTS` (see §4).
