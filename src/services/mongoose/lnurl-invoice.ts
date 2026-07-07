// services/mongoose/lnurl-invoice.ts
import { Schema, model, Types } from "mongoose"

// Invoices issued by the public LNURL-pay proxy callback. LUD-21 verify only
// answers for hashes recorded here — payment hashes are NOT secrets (routing
// nodes and anyone shown the invoice see them), so verify must not disclose
// settlement state or preimages for arbitrary Flash/IBEX invoices.
export interface LnurlInvoiceDoc {
  _id: Types.ObjectId
  invoiceHash: string
  accountUsername: string
  createdAt: Date
}

const lnurlInvoiceSchema = new Schema<LnurlInvoiceDoc>({
  invoiceHash: { type: String, required: true, unique: true },
  accountUsername: { type: String, required: true },
  // TTL: verify polling happens within minutes; proof-of-payment lookups may
  // trail by days. 30 days comfortably covers both without unbounded growth.
  createdAt: { type: Date, default: () => new Date(), expires: "30d" },
})

export const LnurlInvoiceModel = model<LnurlInvoiceDoc>(
  "LnurlInvoice",
  lnurlInvoiceSchema,
)
