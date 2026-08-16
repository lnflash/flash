jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: { invoiceFromHash: jest.fn() },
}))
jest.mock("@config", () => ({
  IbexConfig: { webhook: { uri: "https://ibex.test.flashapp.me", secret: "s" } },
}))
jest.mock("@services/logger", () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(() => logger),
  }
  return { baseLogger: logger }
})
jest.mock("@services/mongoose/wallets", () => ({ WalletsRepository: jest.fn() }))
jest.mock("@services/mongoose/zap-request", () => ({ ZapRequestModel: jest.fn() }))
jest.mock("@services/mongoose/lnurl-invoice", () => ({
  LnurlInvoiceModel: { exists: jest.fn(), create: jest.fn() },
}))
jest.mock("@services/mongoose", () => ({ AccountsRepository: jest.fn() }))
jest.mock("@utils", () => ({ extractPaymentHashFromBolt11: jest.fn() }))
jest.mock("@services/ibex/webhook-server/middleware", () => ({
  authenticate: jest.fn(),
  logRequest: jest.fn(),
  validateIbexIp: jest.fn(),
}))

import { router } from "@services/ibex/webhook-server/routes/on-pay"
import { ibexWebhookEndpoints, ibexWebhookPaths } from "@services/ibex/webhook-config"

type MountedRoute = { path: string; methods: Record<string, boolean> }

const mountedRoutes = (): MountedRoute[] =>
  (router.stack as unknown as { route?: MountedRoute }[])
    .map((layer) => layer.route)
    .filter((route): route is MountedRoute => route !== undefined)

const methodsFor = (path: string): string[] =>
  mountedRoutes()
    .filter((route) => route.path === path)
    .flatMap((route) => Object.keys(route.methods))
    .filter((method) => method !== "_all")

/**
 * `Ibex.payToLnurl` hands IBEX a `webhookUrl` (services/ibex/client.ts), which
 * reads as "a settlement callback will resolve this send". It will not. These
 * assertions pin the gap so the claim cannot be made again by accident, and so
 * that whoever DOES wire the callback is forced to come back here — and to the
 * doc block on `paymentSendStatusFromIbexLnurlPay`, which states the gap — and
 * update both.
 *
 * Until then: an LNURL send that `lnurlPaymentSendStatusOrPending` reports as
 * `pending` is never resolved server-side, and `withPaymentIdempotency` replays
 * that `pending` for 24h under the same key.
 */
describe("payToLnurl settlement webhook — the gap behind a pending LNURL send", () => {
  it("sends IBEX an un-substituted express route template as the webhook URL", () => {
    // `/pay/lnurl/:username` is a route pattern, not a URL. Nothing substitutes
    // the parameter before it is handed to the vendor, so the callback target
    // does not name a user even if IBEX were to POST to it.
    expect(ibexWebhookPaths.onPay.lnurl).toBe("/pay/lnurl/:username")
    expect(ibexWebhookEndpoints.onPay.lnurl).toContain("/pay/lnurl/:username")
  })

  it("mounts no POST handler at the LNURL pay path", () => {
    // The only thing at this path is the PUBLIC GET LNURL-pay callback, which
    // serves INBOUND payments to a Flash user — it has nothing to do with an
    // outbound send's settlement.
    expect(methodsFor(ibexWebhookPaths.onPay.lnurl)).toEqual(["get"])
  })

  it("has no route anywhere on this router that could transition an outbound LNURL send", () => {
    // The two POST webhook routes that do exist are `resp.status(200).end()`
    // stubs on other paths. Listing them here means adding a real handler makes
    // this test fail loudly rather than leaving the doc block stale.
    const postPaths = mountedRoutes()
      .filter((route) => route.methods.post)
      .map((route) => route.path)
      .sort()

    expect(postPaths).toEqual(
      [ibexWebhookPaths.onPay.invoice, ibexWebhookPaths.onPay.onchain].sort(),
    )
  })
})
