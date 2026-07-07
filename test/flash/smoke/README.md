# UAT Smoke Suite

Black-box smoke tests for the integrated UAT matrix. Everything runs through
the **public GraphQL API over HTTP** — no app imports, no database access — so
the same suite targets the local quickstart stack, CI, or a deployed
environment (TEST) after a release.

## Running

Local, against the quickstart stack (boots docker, funds via lnd-outside):

```bash
make smoke            # boots quickstart + runs the full suite
# or, with a stack already running:
SMOKE_DOCKER_HELPERS=true yarn test:smoke
```

Against a deployed environment (read-only-ish: no docker funding; payments
only if the accounts are pre-funded):

```bash
SMOKE_ENDPOINT=https://api.test.flashapp.me/graphql \
SMOKE_PHONE_A=+1876XXXXXXX SMOKE_PHONE_B=+1876YYYYYYY \
SMOKE_CODE=<test-account otp> \
SMOKE_ALLOW_PAYMENTS=false \
yarn test:smoke
```

Set `SMOKE_EXPECT_FLAGS_OFF=false` once bridge/topup/cashout are enabled in the
target environment — the `topupEnabled` flag spec then asserts a boolean
instead of asserting `false`.

## Two tiers

The suite is tiered because the quickstart stack **mocks IBEX** — it can't
resolve wallet balances, create Lightning invoices, register device tokens, or
persist usernames, and its synthetic wallet ids don't satisfy the `WalletId`
scalar.

- **CI tier (default, `SMOKE_BACKEND_FULL=false`)** — everything reachable
  without a provisioned backend: API health, login/session, account+wallet
  identity, transaction-history shape, username-set (accepted), recipient
  non-resolution, payment-validation rejections, `globals.topupEnabled`, and
  that bridge/cashout resolvers respond structurally (no 5xx). This is what
  runs in CI against quickstart and catches the bulk of API-contract, auth,
  and resolver-crash regressions.
- **Full tier (`SMOKE_BACKEND_FULL=true`)** — balances, invoice creation,
  onchain address, default-wallet mutation, device-token registration,
  username resolution, and (with `SMOKE_DOCKER_HELPERS=true` /
  `SMOKE_ALLOW_PAYMENTS=true`) external funding and two-account payments. Run
  against TEST or any environment with a real IBEX backend.

## UAT matrix coverage

| UAT ID | Automated here | Notes |
|--------|----------------|-------|
Tier: **C** = CI (runs against quickstart mock), **F** = full backend only.

| UAT ID | Tier | Spec | Notes |
|--------|------|------|-------|
| SETUP-01 | C | `00-environment` | endpoint healthy, network echo |
| AUTH-01/02 | C | `01-auth-account` | login + session validity (API level) |
| AUTH-03 | C/F | `01-auth-account` | username set (C); recipient resolution (F) |
| AUTH-04 | C | `01-auth-account` | re-login, account/wallets unchanged |
| HOME-01 | C/F | `02-wallets-home` | wallet shape+default (C); balance numeric (F) |
| TX-00 | C | `02-wallets-home` | history shape clean |
| TX-01/02 | F | `05-payments-internal` | both directions, memo, status after a send |
| RECV-03/04/05 | F | `03-receive` | invoice create paths; expired-UI is manual |
| FUND-01/02 | F | `04-funding-external` | needs lnd-outside + real balances |
| EXT-01/02 | F | `04-funding-external` | needs lnd-outside; TEST external wallet is manual |
| EXT-03 | — | manual | LNURL hostname routing is env-specific |
| SEND-01/02 | F | `05-payments-internal` | intraledger both directions with memo |
| SEND-03 | C | `06-validation` | unknown username does not resolve |
| SEND-04/05 | C | `06-validation` | self-send, zero, too-high all rejected |
| CONTACT-01 | F | `05-payments-internal` | contacts populated after payment |
| WALLET-01 | F | `02-wallets-home` | default-wallet mutation (needs real WalletId) |
| WALLET-02/03 | — | manual | conversion UX + max-amount UI flow |
| ONCHAIN-01 | F | `02-wallets-home` | when a BTC wallet exists |
| ONCHAIN-02 | — | manual | below-min UX validation |
| BRIDGE-01 | C | `07-flags-bridge` | `globals.topupEnabled` matches flag state |
| BRIDGE-03/05 | C | `07-flags-bridge` | resolvers respond structurally (no 5xx); WebView/UI manual |
| BRIDGE-02/04 | — | manual | WebView + order/instruction UI |
| NOTIF-01 | F | `07-flags-bridge` | device-token registration; push delivery is manual |
| NOTIF-02/03 | — | manual | push arrival + deep links need devices |
| SCAN-00..03 | — | manual | camera/permissions need devices |
| SETTINGS-*, MAP, REPORT, CHAT | — | manual | device UI |
| WIDGET-01, WATCH-01 | — | manual | iOS platform extensions |

Roughly **14 rows run in CI** (quickstart mock) and **~10 more in the full
tier** against a real backend; the remainder are device-bound UI/UX rows that
stay manual. The CI tier is deliberately the crash/contract/auth/flag safety
net; the full tier is the money-movement confidence you point at TEST.

## Design notes

- Specs are ordered (`00-` … `07-`) and mirror the UAT phase plan; later
  phases depend on backend state created earlier (accounts, funding), not on
  in-process state — every spec re-logs-in with the same deterministic phones.
- Quickstart logins use `UNSECURE_DEFAULT_LOGIN_CODE=000000`; deployed
  environments must list the smoke phones under `test_accounts` in config.
- Money movement is opt-out (`SMOKE_ALLOW_PAYMENTS=false`) for shared
  environments; docker funding is opt-in (`SMOKE_DOCKER_HELPERS=true`).
