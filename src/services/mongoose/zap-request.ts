// services/mongoose/zap-request.ts
import { Schema, model, Types } from "mongoose"

export interface ZapRequestDoc {
    _id: Types.ObjectId
    bolt11: string
    invoiceHash: string
    accountUsername: string
    nostrJson: string
    amountMsat: number
    createdAt: Date
    fulfilled: boolean
}

const zapRequestSchema = new Schema<ZapRequestDoc>({
    bolt11: { type: String, required: true },
    invoiceHash: { type: String, required: true, unique: true },
    accountUsername: { type: String, required: true },
    nostrJson: { type: String, required: true },
    amountMsat: { type: Number, required: true },
    createdAt: { type: Date, default: () => new Date() },
    fulfilled: { type: Boolean, default: false },
})

export const ZapRequestModel = model<ZapRequestDoc>("ZapRequest", zapRequestSchema)
