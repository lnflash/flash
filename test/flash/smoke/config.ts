// Environment-driven configuration so the same suite targets any deployment.
//
//   SMOKE_ENDPOINT        GraphQL URL (default: local quickstart via oathkeeper)
//   SMOKE_PHONE_A/B       test account phones (must be in test_accounts, or the
//                         env must run with UNSECURE_DEFAULT_LOGIN_CODE)
//   SMOKE_CODE            OTP for both accounts (default 000000 = quickstart)
//   SMOKE_EXPECT_FLAGS_OFF assert bridge/topup/cashout are disabled (launch
//                         baseline). Set to "false" for a flags-on environment.
//   SMOKE_ALLOW_PAYMENTS  run money-movement specs (intraledger sends). Default
//                         on; set to "false" for read-only runs against shared
//                         environments you don't want to mutate.
//   SMOKE_DOCKER_HELPERS  allow docker-exec funding via the quickstart
//                         bitcoind/lnd-outside containers (local/CI only).

const bool = (v: string | undefined, dflt: boolean): boolean =>
  v === undefined ? dflt : v !== "false" && v !== "0"

// Unique-per-run suffix so username registration never collides across runs
// against a persistent environment. Pinned in globalSetup so every spec file
// derives the same value.
const runId = process.env.SMOKE_RUN_ID || "local"

export const SMOKE = {
  endpoint: process.env.SMOKE_ENDPOINT || "http://localhost:4002/graphql",
  phoneA: process.env.SMOKE_PHONE_A || "+16505550001",
  phoneB: process.env.SMOKE_PHONE_B || "+16505550002",
  code: process.env.SMOKE_CODE || "000000",
  expectFlagsOff: bool(process.env.SMOKE_EXPECT_FLAGS_OFF, true),
  allowPayments: bool(process.env.SMOKE_ALLOW_PAYMENTS, true),
  dockerHelpers: bool(process.env.SMOKE_DOCKER_HELPERS, false),
  composeProject: process.env.COMPOSE_PROJECT_NAME || "quickstart",
  usernameA: process.env.SMOKE_USERNAME_A || `smoke_a_${runId}`,
  usernameB: process.env.SMOKE_USERNAME_B || `smoke_b_${runId}`,
}
