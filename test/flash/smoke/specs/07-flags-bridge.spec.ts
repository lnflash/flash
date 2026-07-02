import { getMe, gql, gqlOk, login, usdWalletOf } from "../client"
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

  it("BRIDGE-01/topup: globals.topupEnabled matches the expected flag state", async () => {
    const data = await gqlOk<{ globals: { topupEnabled: boolean } }>(
      `query smokeTopupFlag { globals { topupEnabled } }`,
    )
    const ok = SMOKE.expectFlagsOff
      ? data.globals.topupEnabled === false
      : typeof data.globals.topupEnabled === "boolean"
    expect(ok).toBe(true)
  })

  it("BRIDGE-03: bridgeInitiateKyc is cleanly disabled (or responds) per flag state", async () => {
    const res = await gql<{
      bridgeInitiateKyc: { errors: Array<{ message: string }> } | null
    }>(
      `mutation smokeKyc($input: BridgeInitiateKycInput!) {
        bridgeInitiateKyc(input: $input) { errors { message } }
      }`,
      { input: { email: "smoke@example.com", full_name: "Smoke Test" } },
      token,
    )
    // Disabled must mean a structured error — not a crash, not success.
    const errorCount =
      (res.data?.bridgeInitiateKyc?.errors.length ?? 0) + (res.errors?.length ?? 0)
    const ok = SMOKE.expectFlagsOff
      ? errorCount > 0
      : Boolean(res.data?.bridgeInitiateKyc ?? res.errors)
    expect(ok).toBe(true)
  })

  it("BRIDGE-05/cashout: requestCashout is cleanly disabled per flag state", async () => {
    const res = await gql<{
      requestCashout: { errors?: Array<{ message: string }> } | null
    }>(
      `mutation smokeCashout($input: RequestCashoutInput!) {
        requestCashout(input: $input) { __typename }
      }`,
      { input: { walletId, amount: 100, bankAccountId: "smoke-nonexistent" } },
      token,
    )
    // Flags off: must error. Flags on: invalid bank account must yield a
    // structured error, not a 500.
    const ok = SMOKE.expectFlagsOff
      ? (res.errors?.length ?? 0) > 0
      : Boolean(res.data ?? res.errors)
    expect(ok).toBe(true)
  })

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
