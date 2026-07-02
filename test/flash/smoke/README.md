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
target environment — the flag specs then assert the endpoints respond instead
of asserting they're disabled.

## UAT matrix coverage

| UAT ID | Automated here | Notes |
|--------|----------------|-------|
| SETUP-01 | ✅ `00-environment` | endpoint healthy, network echo |
| AUTH-01/02 | ✅ `01-auth-account` | login + session validity (API level) |
| AUTH-03 | ✅ `01-auth-account` | username set + recipient resolution |
| AUTH-04 | ✅ `01-auth-account` | re-login, state unchanged |
| HOME-01 | ✅ `02-wallets-home` | wallets/balances via API (not UI render) |
| TX-00/01/02 | ✅ `02`/`05` | history shape, both directions, memo, status |
| RECV-00/03/04/05 | ✅ `03-receive` | invoice create paths; expiry-set only (expired-UI is manual) |
| FUND-01/02 | ✅ `04-funding-external` | quickstart only (lnd-outside) |
| EXT-01/02 | ✅ `04-funding-external` | quickstart only; TEST needs a real external wallet — manual |
| EXT-03 | ⚠️ partial | LNURL hostname routing is env-specific; keep the TEST manual smoke |
| SEND-01/02 | ✅ `05-payments-internal` | intraledger both directions with memo |
| SEND-03/04/05 | ✅ `06-validation` | invalid recipient, self-send, zero/too-high |
| CONTACT-01 | ✅ `05-payments-internal` | contacts populated after payment |
| WALLET-01 | ✅ `02-wallets-home` | default wallet mutation |
| WALLET-02/03 | ❌ manual | conversion quote UX + max-amount UI flow |
| ONCHAIN-01 | ✅ `02-wallets-home` | when a BTC wallet exists; else logged skip |
| ONCHAIN-02 | ❌ manual | below-min UX validation |
| BRIDGE-01..05 | ⚠️ flags | API-level kill-switch assertions; WebView/UI flows are manual |
| NOTIF-01 | ✅ `07-flags-bridge` | token registration; push *delivery* is manual |
| NOTIF-02/03 | ❌ manual | push arrival + deep links need devices |
| SCAN-00..03 | ❌ manual | camera/permissions need devices |
| SETTINGS-*, MAP, REPORT, CHAT | ❌ manual | device UI |
| WIDGET-01, WATCH-01 | ❌ manual | iOS platform extensions |

Roughly: **24 of 54 rows fully automated, 7 partially** (flags/API-level), the
remainder are device-bound UI/UX rows that stay manual.

## Design notes

- Specs are ordered (`00-` … `07-`) and mirror the UAT phase plan; later
  phases depend on backend state created earlier (accounts, funding), not on
  in-process state — every spec re-logs-in with the same deterministic phones.
- Quickstart logins use `UNSECURE_DEFAULT_LOGIN_CODE=000000`; deployed
  environments must list the smoke phones under `test_accounts` in config.
- Money movement is opt-out (`SMOKE_ALLOW_PAYMENTS=false`) for shared
  environments; docker funding is opt-in (`SMOKE_DOCKER_HELPERS=true`).
