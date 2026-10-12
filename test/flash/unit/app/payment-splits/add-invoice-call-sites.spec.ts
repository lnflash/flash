import { readdirSync, readFileSync, statSync } from "fs"
import { join, relative } from "path"

// ENG-653 risk guard. The internal-transfer marker is a denylist: IBEX binds
// EVERY addInvoice to the on-receive webhook, so a new code path that mints an
// invoice Flash pays itself — without writing the marker — would fire the
// recipient's payment splits on a system credit. Adding a call site makes this
// test fail until it is classified below.
const CLASSIFIED_CALL_SITES: Record<string, string> = {
  // Marked internal (origin "intraledger") before paying.
  "src/app/payments/send-intraledger.ts": "marked",
  // Marked internal (origin "cutover") before the invoice is handed back.
  "src/app/cash-wallet-cutover/runtime-services.ts": "marked",
  // User-facing receive invoices: an external payer pays them; they SHOULD
  // trigger splits.
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
