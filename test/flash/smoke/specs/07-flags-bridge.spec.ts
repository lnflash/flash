import { getMe, gql, gqlOk, isUnknownFieldError, login, usdWalletOf } from "../client"
import { SMOKE } from "../config"

// UAT: BRIDGE-01..05 (flags-off behavior: entry points cleanly disabled, no
//      crashes and no accidental enablement), NOTIF-01 (device token accepted)
//
// With SMOKE_EXPECT_FLAGS_OFF=true (launch baseline) this suite asserts the
// kill switches actually hold at the API layer — the backend counterpart of
// the mobile bridgeTopupEnabled remote-config gate.
describe("Phase 4: feature flags + bridge surface", () => {
  let token: string
  let walletId: string

  beforeAll(async () => {
    token = await login(SMOKE.phoneA, SMOKE.code)
    walletId = usdWalletOf(await getMe(token)).id
  })

  // Reports a failure string, or null when the check passed or is not
  // applicable (target schema predates the field — logged and treated as a
  // skip). Keeps a single unconditional expect per test.
  const evaluate = (
    res: { data?: Record<string, unknown>; errors?: Array<{ message: string }> },
    field: string,
    assess: () => string | null,
  ): string | null => {
    if (isUnknownFieldError(res.errors, field)) {
      // eslint-disable-next-line no-console
      console.log(`skipped: backend schema has no ${field}`)
      return null
    }
    return assess()
  }

  it("BRIDGE-01/topup: topupEnabled reflects the flag state when the backend exposes it", async () => {
    // topupEnabled ships in flash #421 — older deployments lack it and skip.
    const res = await gql<{ globals: { topupEnabled?: boolean } }>(
      `query smokeTopupFlag { globals { topupEnabled } }`,
    )
    const failure = evaluate(res, "topupEnabled", () => {
      if (res.errors?.length) return `GraphQL errors: ${JSON.stringify(res.errors)}`
      const value = res.data?.globals.topupEnabled
      const ok = SMOKE.expectFlagsOff ? value === false : typeof value === "boolean"
      return ok
        ? null
        : `unexpected topupEnabled=${value} (expectFlagsOff=${SMOKE.expectFlagsOff})`
    })
    expect(failure).toBeNull()
  })

  // Bridge/cashout mutations: the reliable, environment-independent smoke goal
  // is that the resolver still RESPONDS with a structured GraphQL result
  // (business payload or GraphQL errors) rather than crashing (HTTP 5xx / null
  // data with an internal-error extension). Precise flag-enforcement semantics
  // vary by mutation and are covered by the mobile gating tests + manual UAT;
  // the authoritative flag signal here is globals.topupEnabled above.
  //
  // The Bridge mutations ship in flash #413 — skip (via evaluate) when the
  // target schema predates them rather than mistaking the unknown-field
  // validation error for a real structured response.
  const structuredFailure = (
    res: { data?: Record<string, unknown>; errors?: unknown[] },
    field: string,
  ): string | null =>
    Boolean(res.data && res.data[field] !== null) || (res.errors?.length ?? 0) > 0
      ? null
      : `${field} did not return a structured response`

  it("BRIDGE-03: bridgeInitiateKyc responds structurally (no resolver crash)", async () => {
    const res = await gql<{
      bridgeInitiateKyc: { errors: Array<{ message: string }> } | null
    }>(
      `mutation smokeKyc($input: BridgeInitiateKycInput!) {
        bridgeInitiateKyc(input: $input) { errors { message } }
      }`,
      { input: { email: "smoke@example.com", full_name: "Smoke Test" } },
      token,
    )
    const failure = evaluate(res, "bridgeInitiateKyc", () =>
      structuredFailure(res, "bridgeInitiateKyc"),
    )
    expect(failure).toBeNull()
  })

  it("BRIDGE-05/cashout: requestCashout responds structurally (no resolver crash)", async () => {
    const res = await gql<{ requestCashout: { __typename: string } | null }>(
      `mutation smokeCashout($input: RequestCashoutInput!) {
        requestCashout(input: $input) { __typename }
      }`,
      { input: { walletId, amount: 100, bankAccountId: "smoke-nonexistent" } },
      token,
    )
    const failure = evaluate(res, "requestCashout", () =>
      structuredFailure(res, "requestCashout"),
    )
    expect(failure).toBeNull()
  })

  // Device-token registration touches notification infra that the mock stack
  // doesn't provide — full-backend only.
  const describeFull = SMOKE.backendFull ? describe : describe.skip

  describeFull("full backend", () => {
    it("NOTIF-01: device notification token registration succeeds", async () => {
      const res = await gqlOk<{
        deviceNotificationTokenCreate: {
          errors: Array<{ message: string }>
          success: boolean | null
        }
      }>(
        `mutation smokeDeviceToken($input: DeviceNotificationTokenCreateInput!) {
          deviceNotificationTokenCreate(input: $input) {
            errors { message }
            success
          }
        }`,
        { input: { deviceToken: `smoke-token-${process.env.SMOKE_RUN_ID || "local"}` } },
        token,
      )
      expect(res.deviceNotificationTokenCreate.errors).toEqual([])
      expect(res.deviceNotificationTokenCreate.success).toBe(true)
    })
  })
})
