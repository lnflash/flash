# API Keys — Architecture

Operator and maintainer view of the FIP-07 API-key authentication system. For the developer-facing surface see [USAGE.md](./USAGE.md).

## Design principle: verify at the gateway, not in the app

Flash's public GraphQL API sits behind Ory Oathkeeper in **decision mode**: the nginx ingress issues an `auth_request` subrequest to oathkeeper's `/decisions` endpoint, oathkeeper authenticates the request and mints an `id_token` JWT, and nginx **replaces** the client's `Authorization` header with that JWT before proxying to the backend (`auth-response-headers: Authorization`). The backend's `expressjwt` layer then only ever trusts an oathkeeper-signed JWT.

Because of this, a raw `fk_…` key placed in `Authorization` could never reach the backend — it would be rejected as a non-JWT bearer before any application code ran. So API-key verification is done **at the gateway**, mirroring Blink's production pattern, and the key travels in a **separate `X-API-KEY` header** so it never collides with the Kratos session path. (This is the ADR recorded under ENG-107.)

## Request flow

```
                 X-API-KEY: fk_…
   client ──────────────────────────►  nginx ingress
                                           │  auth_request subrequest
                                           ▼
                                        oathkeeper  /decisions
                                           │  bearer_token authenticator
                                           │  (token_from X-API-KEY, force GET)
                                           ▼
                              backend  GET /auth/api-key/check   ◄── cluster-internal only
                                           │  parse → hash compare → expiry → IP → account
                                           ▼
                              kratos-whoami-shaped JSON response
                                           │
                                           ▼
                              oathkeeper  id_token mutator
                                           │  mints JWT: sub, session_id=apikey:<keyId>,
                                           │  scope, rate_limit
                                           ▼
   client  ◄───  nginx  ──── JWT in Authorization ────►  backend /graphql
                                           │  expressjwt → setGqlContext →
                                           │  api-key rate-limit middleware →
                                           │  graphql-shield (scope enforcement) → resolvers
```

A Kratos session takes the same path but matches an earlier oathkeeper authenticator (`cookie_session` / `bearer_token` against Kratos whoami); a request with no recognized credential falls through to `anonymous`.

## The check endpoint

`GET /auth/api-key/check` (`src/servers/authorization/api-key-check.ts`) is the verification backend for the oathkeeper authenticator. It is **cluster-internal**: no oathkeeper rule matches its path, so ingress decision-mode denies any external request to it.

It reads `X-API-KEY`, then `verifyApiKey` (`src/app/api-keys/verify-api-key.ts`):

1. Parse `fk_{keyId}_{secret}` (anchored regex; malformed → reject).
2. Look up the key by its public `keyId`.
3. Reject if past `expiresAt`.
4. Compare `sha256(secret)` against the stored hash in **constant time** (`timingSafeEqual`).
5. Enforce IP constraints (see below), fail-closed.
6. Resolve the owning account's Kratos user id.
7. Throttled `lastUsedAt` update (≤ once per key per minute — keeps verification read-only on hot keys).

On success it returns a **kratos-whoami-shaped** body so oathkeeper's existing `subject_from`/`extra_from` config and `id_token` mutator apply unchanged:

```json
{
  "identity": { "id": "<kratos-user-id>" },
  "id": "apikey:<keyId>",
  "expires_at": "",
  "scope": "read:wallet write:wallet",
  "rate_limit": 300
}
```

- `identity.id` → JWT `sub`: the key resolves to a normal account, so downstream code needs **zero** changes to load it.
- `id` → JWT `session_id`: the `apikey:` prefix marks this as a key session (never a real Kratos session id), which the backend uses to branch behavior.
- `expires_at` is always empty: key expiry is enforced here on every verification, and a value would make session handling try to Kratos-extend the synthetic session id.
- `scope` (space-delimited) and `rate_limit` (numeric) become JWT claims via conditional segments in the mutator template.

Any failure returns `401 {"error":"invalid_api_key"}`, which oathkeeper surfaces as an explicit gateway `401` — the same result as an invalid Kratos token.

## Scope enforcement (graphql-shield)

Scopes are enforced in-process with **graphql-shield**, deny-by-default, from `src/domain/api-keys/scope-map.ts`:

- **`apiKeyScopeForField`** — every authed root query/mutation mapped to the scope it requires, or `BLOCKED`. Non-API-key sessions pass through untouched; for an API-key session the shield rule requires the mapped scope, and any field **not** in the map (or mapped `BLOCKED`) is rejected. A completeness unit test fails CI if a new authed field is added without a mapping, so the deny-by-default guarantee can't silently regress.
- **`apiKeyNestedFieldScopes`** — type-level guards (`ConsumerAccount`, `UserContact`, `BTCWallet`, `UsdWallet`, `UsdtWallet`) so wallet/transaction data reachable *through* a low-scope root field (e.g. `me`, which only needs `read:user`) still requires `read:wallet` / `read:transactions`. This closes the nested-escalation path.

`hasApiKeyScope` implements the implication rules: `admin` grants everything, `write:X` implies `read:X`. Scope claims arrive on the GraphQL context via `session.ts`, which splits the space-delimited `scope` JWT claim into `ctx.scopes`.

## IP constraints

The client IP the check endpoint enforces against comes from `X-Real-Ip`. On the oathkeeper `auth_request` subrequest path, nginx does **not** set `X-Real-IP` by default (it sets it only on the main upstream), so the ingress `auth-snippet` explicitly forces it:

```
proxy_set_header X-Real-IP $remote_addr;
```

This overwrites any client-supplied value with the ingress-observed peer, making the header trustworthy on this path (the ENG-105 fix). The IP-constraint control **depends on this snippet** — see the warning comment in `api-key-check.ts`. In the local dev proxy topology (no ingress) `X-Real-Ip` is client-controlled, which is acceptable for dev only.

Matching (`src/domain/api-keys/ip-constraints.ts`, via `ipaddr.js`) handles bare IPs and CIDR ranges, normalizes IPv4-mapped IPv6, treats family mismatches as non-matches, and never throws.

## Rate limiting

Per-key request limiting lives in an express middleware (`src/servers/middlewares/api-key-rate-limit.ts`) registered **after** `setGqlContext` and **before** Apollo. It:

- Skips non-API-key sessions.
- Reads the key's limit from the `rate_limit` JWT claim (falling back to the config default).
- Consumes from a `rate-limiter-flexible` Redis limiter (`src/services/rate-limit/api-keys.ts`), keyed on `keyId`, one limiter instance per distinct limit value.
- On rejection, short-circuits with an HTTP `200` GraphQL error carrying `extensions.code = TOO_MANY_REQUESTS` plus `retryAfterSeconds` and `rateLimit { limit, remaining }`. It also sets `X-RateLimit-*` / `Retry-After` headers best-effort.
- **Fails open** on any internal/Redis error — rate limiting must never take the API down.

**Why a GraphQL error, not an HTTP `429`.** This `/graphql` server is a federation subgraph behind the Apollo router. The router forwards a subgraph response to the client only when it is HTTP `2xx` with a GraphQL body; a bare `429` from the subgraph is swallowed and re-emitted as an opaque `SUBREQUEST_HTTP_ERROR`, and subgraph response headers are dropped. Returning `200` + a GraphQL error with the retry metadata in `extensions` is the only shape that reaches the client intact through the router, and it matches how every other galoy rate limit surfaces (`TOO_MANY_REQUEST`). The `X-RateLimit-*` / `Retry-After` headers are still set for callers that reach the service directly (no router in between). This was confirmed end-to-end against the router: a bare `429` reached the client as `SUBREQUEST_HTTP_ERROR`, while the GraphQL-error form arrives as a clean `TOO_MANY_REQUESTS`.

Config: `apiKeys.defaultRequestsPerMinute` (default 120) and `apiKeys.maxKeysPerAccount` (default 10), read via `src/config/api-keys.ts`.

## Observability

**Metrics (ENG-103)** — prom-client counters on the default registry (`src/services/api-keys-metrics.ts`):

- `galoy_api_key_verification_total{result,reason}` — `result` = `success`|`denied`, `reason` = the denial's error class (or `ok`).
- `galoy_api_key_rate_limited_total`
- `galoy_api_key_management_total{operation,result}` — `operation` = `create`|`revoke`|`rotate`|`list`.

Verification, rate limiting, and management all run inside the **API pods** (not the standalone exporter), so a per-pod listener (`src/servers/api-key-metrics.ts`) exposes `/metrics` on `API_METRICS_PORT` (default **3001**), started from the main API entrypoint only — never in the admin/ws/trigger/exporter processes. The API deployment carries `prometheus.io/{scrape,path,port}` annotations for this port.

**Audit (ENG-104)** — a pino child logger (`module: api-keys-audit`, `src/services/api-keys-audit.ts`) emits fields-object-first events with a stable `event` discriminator: `api_key.created`, `api_key.revoked`, `api_key.rotated`, `api_key.denied`, `api_key.rate_limited`. **Only the public `keyId` is ever logged** — never the raw key, secret, or hash. These are structured logs (no new DB write path); usage history is intended to ride metrics + logs rather than a per-request DB write.

## Subscriptions / WebSocket

API keys **cannot** reach the GraphQL subscriptions (WS) server: the WS auth path never forwards `X-API-KEY`, so a `fk_…` credential falls through to anonymous there. Scope enforcement is a shield concern on the HTTP schema; if `X-API-KEY` forwarding is ever added to the WS path, scope enforcement must be added to its context construction, since shield does not run there.

## Charts / infra changes

The gateway wiring lives in the charts repo (`charts/flash`):

- **`values.yaml`** — the `flash-router` oathkeeper `accessRules`: the added `bearer_token` authenticator (`token_from: X-API-KEY`, `forward_http_headers: [X-API-KEY, X-Real-Ip]`, `force_method: GET`) pointing at `/auth/api-key/check`, and the `id_token` claims template extended with conditional `scope` and `rate_limit` claims.
- **`templates/api-ingress.yaml`** — the `auth-snippet` line forcing `X-Real-IP` from `$remote_addr` on the auth subrequest (ENG-105).
- **`templates/api-deployment.yaml`** — prometheus scrape annotations and the metrics container port for the per-pod API-key metrics listener.

The dev equivalents live in `dev/ory/oathkeeper_rules.yaml` (the `galoy-backend` rule).
