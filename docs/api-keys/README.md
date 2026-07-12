# API Keys (FIP-07)

API keys give **server-to-server and third-party developer applications** programmatic access to the Flash public GraphQL API, without a mobile-app login (Kratos) session. They are the credential a BTCPayServer plugin, a back-office script, or a partner integration uses to call Flash on behalf of a single account.

- **[USAGE.md](./USAGE.md)** — developer guide: creating, using, listing, rotating, and revoking keys; the scope model; rate-limit, IP, and error behavior.
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — operator/maintainer guide: the gateway design, verification, scope enforcement, IP handling, rate limiting, metrics, and audit.

## Key format

```
fk_{keyId}_{secret}
```

- `keyId` — 8 lowercase hex characters. A **public** identifier that appears in the API-key list, audit logs, and metrics. It is *not* a secret.
- `secret` — 64 base64url characters, generated from 48 random bytes.

Only the **SHA-256 hash of the secret** is stored. The full `fk_…` string is returned exactly once, at creation (and again on rotation), and can never be retrieved afterward. If it is lost, rotate or revoke and issue a new key.

## How API keys differ from user sessions

| | Kratos session (mobile app) | API key |
|---|---|---|
| Credential | session token / cookie | `fk_…` string |
| Sent as | `Authorization: Bearer …` | `X-API-KEY` header |
| Scope | full account access | limited to the key's granted scopes |
| Can manage API keys | **yes** | **no** (see below) |
| Reaches subscriptions (WS) | yes | no |

## Security properties

- **Hash-only storage** — the raw secret is never persisted; verification compares a SHA-256 hash in constant time.
- **Fine-grained scopes** — a key is limited to the FIP-07 scopes granted to it (`read:wallet`, `write:wallet`, `read:transactions`, `write:transactions`, `read:user`, `write:user`, `admin`), enforced deny-by-default. Sensitive operations (login/identity, KYC, cashout, and key management itself) are never callable by any key.
- **IP constraints** — a key may be pinned to one or more IPs/CIDR ranges; requests from other addresses are rejected (fail-closed).
- **Per-key rate limits** — each key has a requests-per-minute limit (platform default, overridable per key); exceeding it returns a `TOO_MANY_REQUESTS` GraphQL error with retry metadata.
- **Expiry** — a key may be given a lifetime; expired keys stop authenticating and report status `EXPIRED`.
- **Revocation** — revoking a key stops it being honored on the very next request.

## Keys cannot manage keys

Creating, listing, rotating, and revoking API keys all require a **Kratos session** (i.e. a logged-in user at account level). A request authenticated *with an API key* is rejected from every management operation. This prevents a leaked key from minting more keys or escalating its own privileges — key management is always a human-in-the-loop action.
