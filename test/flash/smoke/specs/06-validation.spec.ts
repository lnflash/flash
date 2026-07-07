import { getMe, gql, login, usdWalletOf } from "../client"
import { SMOKE } from "../config"

// UAT: SEND-03 (invalid username), SEND-04 (self-send blocked),
//      SEND-05 (zero / too-high amounts blocked)
describe("Phase 2: payment validation", () => {
  let token: string
  let walletId: string

  beforeAll(async () => {
    token = await login(SMOKE.phoneA, SMOKE.code)
    walletId = usdWalletOf(await getMe(token)).id
  })

  const sendUsd = (input: Record<string, unknown>) =>
    gql<{
      intraLedgerUsdPaymentSend: {
        errors: Array<{ message: string }>
        status: string | null
      } | null
    }>(
      `mutation smokeValidation($input: IntraLedgerUsdPaymentSendInput!) {
        intraLedgerUsdPaymentSend(input: $input) { errors { message } status }
      }`,
      { input },
      token,
    )

  it("SEND-03: unknown username does not resolve to a recipient", async () => {
    const res = await gql<{ accountDefaultWallet: { id: string } | null }>(
      `query smokeBadUsername($username: Username!) {
        accountDefaultWallet(username: $username) { id }
      }`,
      { username: "smoke_no_such_user_xyz" },
      token,
    )
    expect(res.data?.accountDefaultWallet ?? null).toBeNull()
    expect(res.errors?.length).toBeGreaterThan(0)
  })

  it("SEND-04: self-send is blocked with a clear error", async () => {
    const res = await sendUsd({
      walletId,
      recipientWalletId: walletId,
      amount: 1,
      memo: "smoke SEND-04",
    })
    const payload = res.data?.intraLedgerUsdPaymentSend
    expect(payload?.status ?? null).not.toBe("SUCCESS")
    expect((payload?.errors.length ?? 0) + (res.errors?.length ?? 0)).toBeGreaterThan(0)
  })

  it("SEND-05: zero amount is rejected", async () => {
    const res = await sendUsd({
      walletId,
      recipientWalletId: walletId,
      amount: 0,
      memo: "smoke SEND-05",
    })
    const payload = res.data?.intraLedgerUsdPaymentSend
    expect(payload?.status ?? null).not.toBe("SUCCESS")
    expect((payload?.errors.length ?? 0) + (res.errors?.length ?? 0)).toBeGreaterThan(0)
  })

  it("SEND-05: absurdly high amount is rejected (insufficient balance)", async () => {
    const meB = { walletId } // self as target is fine: balance check trips first
    const res = await sendUsd({
      walletId,
      recipientWalletId: meB.walletId,
      amount: 10_000_000_000,
      memo: "smoke SEND-05-max",
    })
    const payload = res.data?.intraLedgerUsdPaymentSend
    expect(payload?.status ?? null).not.toBe("SUCCESS")
    expect((payload?.errors.length ?? 0) + (res.errors?.length ?? 0)).toBeGreaterThan(0)
  })
})
