import { readdirSync, readFileSync, statSync } from "fs"
import { join, relative } from "path"

// ENG-717 risk guard. The internal-transfer marker is a denylist: IBEX binds
// EVERY addInvoice to the on-receive webhook, so a new code path that mints an
// invoice Flash pays itself — without writing the marker — would fire the
// recipient's payment splits on a system credit. Adding a call site makes this
// test fail until it is classified below.
//
// ENG-717 adds a second, allowlist-shaped guard on top: every USER-FACING
// receive mint site must route through receiveAccountFor (the shadow). See
// add-invoice-for-wallet.spec.ts's ROUTED_MINT_SITES check.
const CLASSIFIED_CALL_SITES: Record<string, string> = {
  // Marked internal (origin "intraledger") before paying.
  "src/app/payments/send-intraledger.ts": "marked",
  // Marked internal (origin "cutover") before the invoice is handed back.
  "src/app/cash-wallet-cutover/runtime-services.ts": "marked",
  // ENG-717 payout legs: marked internal (origin "split") before paying.
  "src/app/payment-splits/internal-transfer.ts": "marked",
  // User-facing receive invoices: an external payer's payment SHOULD trigger
  // splits. A Flash user paying one (QR scan, Lightning address) does not:
  // the pay paths below mark the hash before / right after paying.
  "src/app/wallets/add-invoice-for-wallet.ts": "user-receive",
  "src/graphql/public/root/mutation/ln-noamount-invoice-create.ts": "user-receive",
  // Cashout: the user pays an invoice on Flash's own cashout wallet. Flash's
  // wallets carry no split rules, so this receive has no rules to trigger.
  "src/app/offers/CashoutManager.ts": "flash-owned-recipient",
}

const listTs = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return listTs(path)
    return path.endsWith(".ts") && !path.endsWith(".d.ts") ? [path] : []
  })

// ENG-653 decision 1: Flash-to-Flash payments never trigger splits. A Flash
// user can pay another Flash wallet through any of these, so each must mark the
// paid hash (or be classified as unable to reach a split wallet).
const CLASSIFIED_PAY_CALL_SITES: Record<string, string> = {
  // Pays the invoice it minted itself, after marking it (origin intraledger).
  "src/app/payments/send-intraledger.ts": "marked",
  // Pays the cutover invoice it minted and marked (origin cutover).
  "src/app/cash-wallet-cutover/runtime-services.ts": "marked",
  // ENG-717 payout legs: pays the invoice it minted and marked (origin split).
  "src/app/payment-splits/internal-transfer.ts": "marked",
  // Bolt11 pays: marked (origin ln-send) before paying, fail-closed.
  "src/graphql/public/root/mutation/ln-invoice-payment-send.ts": "marked",
  "src/graphql/public/root/mutation/ln-noamount-usd-invoice-payment-send.ts": "marked",
  // LNURL pay: IBEX fetches the invoice, so the hash is marked (origin
  // lnurl-send) after paying and the executor re-checks before every payout.
  "src/graphql/public/root/mutation/lnurl-payment-send.ts": "marked-after-pay",
  // Cashout: pays Flash's own cashout wallet, which carries no split rules.
  "src/app/offers/ValidOffer.ts": "flash-owned-recipient",
  // Mentions Ibex.payToLnurl in a doc comment only.
  "src/services/ibex/payment-status.ts": "comment-only",
}

const listCallers = (pattern: RegExp): string[] => {
  const root = join(__dirname, "../../../../..")
  return listTs(join(root, "src"))
    .filter((path) => !path.endsWith(join("services", "ibex", "client.ts")))
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(root, path).split("\\").join("/"))
    .sort()
}

describe("Ibex.payInvoice / Ibex.payToLnurl call sites", () => {
  it("are all classified for the Flash-to-Flash split marker", () => {
    expect(listCallers(/\bIbex\.(payInvoice|payToLnurl)\b/)).toEqual(
      Object.keys(CLASSIFIED_PAY_CALL_SITES).sort(),
    )
  })
})

describe("Ibex.addInvoice call sites", () => {
  it("are all classified for the payment-splits marker", () => {
    const root = join(__dirname, "../../../../..")
    const callers = listTs(join(root, "src"))
      .filter((path) => !path.endsWith(join("services", "ibex", "client.ts")))
      .filter((path) => /\bIbex\.addInvoice\b/.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path).split("\\").join("/"))
      .sort()

    expect(callers).toEqual(Object.keys(CLASSIFIED_CALL_SITES).sort())
  })
})
