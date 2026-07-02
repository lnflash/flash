import { getMe, gqlOk, lndOutside, login, retry, usdWalletOf } from "../client"
import { SMOKE } from "../config"

// UAT: FUND-01/02 (seed balances), EXT-02 (external wallet -> Flash),
//      EXT-01 (Flash -> external wallet)
//
// Requires the quickstart docker stack (lnd-outside) — gated behind
// SMOKE_DOCKER_HELPERS so read-only runs against shared environments skip it.
const describeMaybe = SMOKE.dockerHelpers ? describe : describe.skip

describeMaybe("Phase 1/3: external funding via lnd-outside", () => {
  let token: string
  let usdWalletId: string

  beforeAll(async () => {
    token = await login(SMOKE.phoneA, SMOKE.code)
    usdWalletId = usdWalletOf(await getMe(token)).id
  })

  it("FUND-01 / EXT-02: paying a Flash invoice from an external wallet credits the balance", async () => {
    const before = usdWalletOf(await getMe(token)).balance

    const res = await gqlOk<{
      lnUsdInvoiceCreate: {
        errors: Array<{ message: string }>
        invoice: { paymentRequest: string } | null
      }
    }>(
      `mutation smokeFundInvoice($input: LnUsdInvoiceCreateInput!) {
        lnUsdInvoiceCreate(input: $input) {
          errors { message }
          invoice { paymentRequest }
        }
      }`,
      { input: { walletId: usdWalletId, amount: 500, memo: "smoke FUND-01" } },
      token,
    )
    expect(res.lnUsdInvoiceCreate.errors).toEqual([])
    const paymentRequest = res.lnUsdInvoiceCreate.invoice?.paymentRequest
    expect(paymentRequest).toBeTruthy()

    lndOutside(["payinvoice", "--force", `${paymentRequest}`])

    const after = await retry(
      async () => usdWalletOf(await getMe(token)).balance,
      (b) => b > before,
    )
    expect(after).toBeGreaterThan(before)
  })

  it("EXT-01: Flash pays a small external Lightning invoice", async () => {
    const added = JSON.parse(
      lndOutside(["addinvoice", "--amt", "100", "--memo", "smoke EXT-01"]),
    ) as { payment_request: string }

    const res = await gqlOk<{
      lnInvoicePaymentSend: {
        errors: Array<{ message: string }>
        status: string | null
      }
    }>(
      `mutation smokeExternalPay($input: LnInvoicePaymentInput!) {
        lnInvoicePaymentSend(input: $input) { errors { message } status }
      }`,
      {
        input: { walletId: usdWalletId, paymentRequest: added.payment_request },
      },
      token,
    )
    expect(
      `${res.lnInvoicePaymentSend.status} ${JSON.stringify(res.lnInvoicePaymentSend.errors)}`,
    ).toBe("SUCCESS []")
  })
})
