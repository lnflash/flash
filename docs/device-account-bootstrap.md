# Owned resumable device-account bootstrap

This source patch hardens `POST /auth/create/device-account` while retaining Basic
UUID credentials, App Check, and the success body `{ "result": "<token>" }`. It does
not deploy the endpoint or provision a real identity/provider resource. Native must
use the separately reviewed authenticated raw owned-wallet snapshot; the existing
ConsumerAccount wallet presentation hides one cash currency and its public UUID is
not the Mongo wallet account ID. A successful login response alone is insufficient
for native session handoff.

## Admission and ownership

Every attempt first authenticates the exact Basic username/password. Only an active
Kratos session with the exact active device-schema identity and exact username can
reach the engine. The engine then freshly reads that identity through the admin
API, requesting only TOTP credential presence. TOTP-enabled, inactive, upgraded
phone-schema, foreign identity, conflicting device metadata, or phone metadata
identities cannot use this route as an alternate factor or repair path.

Only a freshly created admin identity receives atomic admin-only provenance
`metadata_admin.deviceBootstrap = {version:1,deviceIdHash:SHA256(username)}`. The 409
password-login path never updates/adopts a legacy identity. This is a creation
provenance record, not a client assertion or rollout flag. Existing unmarked legacy
identities can use already complete owned local accounts, or repair a missing local
USDT default when both required wallets already exist at level zero. An incomplete
untracked legacy attempt requires support: absence of a journal is not evidence
that an earlier provider call did not succeed.

The route locks the hashed device identity first, then the engine locks the reserved
account ID. All mutations use freshly checked ownership. Duplicate local account,
user binding, wallet ID, or required cash wallet candidates fail closed. Metadata
updates preserve phone/preferences and never call the old broad user updater.
The unused non-journaled device-create helper is removed; phone onboarding retains
its existing behavior.

## Durable state and external dispatch

`DeviceAccountBootstrap` is a new collection keyed by SHA256(device UUID). It stores
owner/account IDs, version, mode, timestamps, and per-currency state; no Basic
password, bearer, raw Basic username, provider response body, or balance. Every
journal/local write introduced here requests Mongo majority acknowledgement and
journaling. The account ID is reserved before account insertion or provider calls.
The primary key is unique by Mongo construction; no unsafe uniqueness migration
is applied to existing account/user/wallet rows.

| State | Meaning | Allowed recovery |
| --- | --- | --- |
| planned | No dispatch intent persisted for this currency | Reuse one actual owned local Checking wallet, or begin one provider dispatch |
| dispatching | Intent/attempt persisted before provider invocation | Support-required; never call provider again merely because a response was lost |
| known | Validated provider ID/name/currency persisted before local attachment | Resume owned local attachment; do not create another provider account |
| attached | Exact owned local wallet attached | Recheck actual wallet; never recreate a missing/deleted wallet |
| blocked | Provider returned an invalid/foreign/unsupported receipt | Support-required; preserve safe observed provider ID when available |

The pinned ibex-client 3.3.0 wrapper refreshes credentials and retries once only
after an explicit HTTP 401. It does not retry timeout/unknown/provider errors; this
existing behavior assumes a 401 rejects resource creation before acceptance. No
application-level redispatch is permitted after an ambiguous result.

IBEX `createAccount` has no proven idempotency or authoritative lookup by request
key. Calling it again may create a fresh resource; no name/email matching is used
as reconciliation. Returned IDs must be bounded ASCII IDs with exact account-name
and currency matches. A response is recorded as `known` even if cancellation,
identity change, or local attachment failure follows. Unknown provider errors,
lost intent acknowledgement, and missing receipt persistence remain unresolved.
A proven cancellation immediately after persisted intent but before invocation is
the sole permitted intent rollback. A crash in that same gap remains conservative
support-required. Local partial writes with an already durable receipt are safe to
resume after process restart using the same authenticated pair.

Operator reconciliation must independently establish actual provider ownership and
currency before atomically recording an exact known receipt; merely finding local
wallets cannot clear an unknown dispatch. No operator tool or guessed lookup is
introduced here. Repeated explicit requests with the same pair cannot recreate an
unresolved resource; after valid authoritative reconciliation they can resume local
completion. Journals have no TTL and must not be deleted or restored independently
of their corresponding account/provider history. Loss of the journal through
manual changes or inconsistent disaster recovery requires external reconciliation,
not an assurance of idempotency. No pruning of unresolved records is safe.

## Required readiness and preservation

At this bootstrap boundary, an active account must have exactly one actual owned
Checking USD and exactly one actual owned Checking USDT wallet, and an actual owned
default wallet. Duplicate required cash wallets require support before any further
provider dispatch/attachment/default changes. This is a bounded bootstrap contract,
not a global claim that every multi-wallet account is invalid.

An existing valid default is preserved, including External or BTC defaults. Existing
level, status, preferences and wallet ownership are not reset. Only level-zero
accounts may receive a missing unambiguous USDT default. Upgraded partial accounts
are not initialized through this path. A ready journal is rechecked against actual
local ownership; missing resources cannot cause fresh provider creation. Optional
LNURL assignment is not part of the required cash-wallet readiness proof.

The public USDT presentation auto-heal checks for any controlled journal inside its
existing account lock before creation or legacy-default rewriting. Controlled
accounts with missing USDT fail closed, regardless of journal phase or later
phone-schema upgrade. Existing USDT is returned without changing a selected default.
A failed journal read cannot fall through to provider creation. Ordinary untracked
phone-account presentation retains existing behavior; no same-lock nesting is added.

## REST outcomes, cancellation and privacy

A token is returned only after final fresh identity/account/wallet/default checks,
not because Kratos reported a newly created identity. Existing-device login always
runs the readiness engine. Closed error codes are additive to the existing error
body:

- `DEVICE_BOOTSTRAP_SUPPORT_REQUIRED`: unresolved provider state, ambiguous/legacy
  partial state, or required resource conflict. Preserve credentials; explicit
  same-pair recheck may recover after authoritative operator reconciliation.
- `DEVICE_BOOTSTRAP_RETRY_REQUIRED`: proven local/pre-dispatch failure or cancellation;
  explicit same-pair retry can resume. This is not permission for automatic retries.
- `DEVICE_BOOTSTRAP_OWNER_MISMATCH`: source ownership differs or is ambiguous.
- `DEVICE_BOOTSTRAP_INCOMPATIBLE_IDENTITY`: inactive/non-device/TOTP/provenance conflict.

Unknown exceptions are sanitized; provider prose and credentials are never reflected.
Malformed usernames produce fixed text. The route removes the former explicit span
attribute containing the Basic username. Aborted/closed requests cancel future
local work and cannot receive a late token; already in-flight provider requests
are not assumed cancelled and their known receipts are still persisted.

**Release dependency:** this branch starts from a source baseline whose generic
tracing wrappers capture arguments. It must be integrated with the central telemetry
privacy patch `4921212` (and root's broader explicit-attribute review) before release.
This patch alone does not claim all tracing/logging sinks are sanitized. New
bootstrap code never intentionally logs credentials, request bodies or provider
errors. No real credentials, provider requests or accounts were used in validation.

## Reproducible validation

Tests use injected/mocked provider, Kratos, Redis-lock and Mongo dependencies. They
exercise the actual repository predicates/write concerns and actual REST handler,
including a lock mock that reproduces callback exception conversion. They do not
prove deployed Mongo durability, Redis lease behavior, production Kratos schema,
provider receipt semantics or live operator reconciliation.

Use Node 24 with the exact frozen-lockfile dependency installation, not an inherited
node_modules tree. In this review, the worktree node_modules is a symlink to
`/Users/dread/Repos/flash-native-parity-backend/node_modules`. The focused suites are
`device-account-bootstrap`, `device-bootstrap-adapters`, mongoose `device-bootstrap`,
Kratos `device-bootstrap-identity`, `ensure-usdt-wallet`, `device-bootstrap-presentation`,
`login-device-bootstrap`, and `device-bootstrap-route`, under `test/flash/unit`.
No .env file or real service credential is needed for those mocked suites.

Final focused result: 119 tests across 8 suites passed; independently repeated with
safe dummy environment and the strict network guard. Broader result: 160 tests
across 15 suites passed with the same guard and natural process exit zero. The
legacy recipient-routing test now mocks an otherwise eager Redis adapter and
throws if its complete-wallet fixtures unexpectedly request repair. Declaration
(`tsconfig.d.json`), whole-tree, and production (`tsconfig-build.json`) TypeScript
checks and lint on every changed/new TypeScript file pass with the exact dependency
tree. Run Jest with `--runInBand --watchman=false --runTestsByPath`; disabling
Watchman avoids an unrelated Unix-socket connection under the strict network guard.
The integration runner's exported `safeEnvironment` and network preload provide
the reproducible no-inherited-credentials/no-unmocked-network harness; no local
.env file is read.
