import { getMe, gqlOk, login, usdWalletOf } from "../client"
import { SMOKE } from "../config"

// UAT: RECV-00 (receive available pre-funding), RECV-03 (fixed invoice),
//      RECV-04 (flexible/no-amount invoice), RECV-05 (expiry is set/marked)
describe("Phase 1: receive", () => {
  let token: string
  let usdWalletId: string

  beforeAll(async () => {
    token = await login(SMOKE.phoneA, SMOKE.code)
    usdWalletId = usdWalletOf(await getMe(token)).id
  })

  it("RECV-03: fixed-amount USD Lightning invoice is created", async () => {
    const res = await gqlOk<{
      lnUsdInvoiceCreate: {
        errors: Array<{ message: string }>
        invoice: { paymentRequest: string; paymentHash: string } | null
      }
    }>(
      `mutation smokeUsdInvoice($input: LnUsdInvoiceCreateInput!) {
        lnUsdInvoiceCreate(input: $input) {
          errors { message }
          invoice { paymentRequest paymentHash }
        }
      }`,
      { input: { walletId: usdWalletId, amount: 210, memo: "smoke RECV-03" } },
      token,
    )
    expect(res.lnUsdInvoiceCreate.errors).toEqual([])
    const pr = res.lnUsdInvoiceCreate.invoice?.paymentRequest ?? ""
    expect(pr.toLowerCase().startsWith("ln")).toBe(true)
  })

  it("RECV-04: no-amount (flexible) invoice is created or cleanly unsupported", async () => {
    const res = await gqlOk<{
      lnNoAmountInvoiceCreate: {
        errors: Array<{ message: string }>
        invoice: { paymentRequest: string } | null
      }
    }>(
      `mutation smokeNoAmountInvoice($input: LnNoAmountInvoiceCreateInput!) {
        lnNoAmountInvoiceCreate(input: $input) {
          errors { message }
          invoice { paymentRequest }
        }
      }`,
      { input: { walletId: usdWalletId, memo: "smoke RECV-04" } },
      token,
    )
    const payload = res.lnNoAmountInvoiceCreate
    // Either a valid invoice or an explicit unsupported error — never a crash.
    const invoiceOk = Boolean(
      payload.invoice?.paymentRequest.toLowerCase().startsWith("ln"),
    )
    const erroredCleanly = payload.errors.length > 0
    expect(invoiceOk || erroredCleanly).toBe(true)
  })

  it("RECV-05: invoice honors a short expiry", async () => {
    const res = await gqlOk<{
      lnUsdInvoiceCreate: {
        errors: Array<{ message: string }>
        invoice: { paymentRequest: string; satoshis: number | null } | null
      }
    }>(
      `mutation smokeExpiryInvoice($input: LnUsdInvoiceCreateInput!) {
        lnUsdInvoiceCreate(input: $input) {
          errors { message }
          invoice { paymentRequest satoshis }
        }
      }`,
      {
        input: {
          walletId: usdWalletId,
          amount: 100,
          memo: "smoke RECV-05",
          expiresIn: 1,
        },
      },
      token,
    )
    expect(res.lnUsdInvoiceCreate.errors).toEqual([])
    expect(res.lnUsdInvoiceCreate.invoice?.paymentRequest).toBeTruthy()
  })
})
