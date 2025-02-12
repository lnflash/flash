import { WalletCurrency } from "@domain/shared"
import mongoose, { Schema } from "mongoose"

// export interface OfferRecord {
//   // _id: Schema.Types.ObjectId,
//   walletId: WalletId
//   accountId: AccountId
//   ibexTransfer: Amount<"USD">
//   rtgsLiability: Amount<"USD"> | Amount<"JMD">
//   exchangeRate: number | undefined
//   flashFee: Amount<"USD">
//   createdAt: Date
//   expiresAt: Date
// }

// const AmountField = {
//   amount: {
//     type: BigInt,
//     required: true,
//     min: 0, 
//   },
//   currency: {
//     type: String,
//     enum: Object.values(WalletCurrency),
//     required: true,
//     uppercase: true, 
//     minlength: 3,
//     maxlength: 3, 
//   },
// }
const AmountSchema = new Schema(
  {
    amount: {
      type: BigInt,
      required: true,
      min: 0, 
    },
    currency: {
      type: String,
      enum: Object.values(WalletCurrency),
      required: true,
      uppercase: true, 
      minlength: 3,
      maxlength: 3,
    } 
  },
  { _id: false }
);

const OfferSchema = new Schema<OfferRecord>({
  // _id: {
  //   type: Schema.Types.ObjectId,
  //   index: true,
  //   unique: true,
  //   required: true,
  // },
  walletId: {
    type: String,
    required: true,
    unique: true, // only one offer per user to prevent.
  },
  ibexTransfer: {
    type: AmountSchema,
    required: true,
  },
  usdLiability: {
    type: AmountSchema,
    required: true,
  },
  jmdLiability: {
    type: AmountSchema,
    required: true,
  },
  flashFee: {
    type: AmountSchema,
  },
  exchangeRate: {
    type: Number,
  },
  createdAt: {
    type: Date
  },
  expiresAt: {
    type: Date
  }
})

export const OfferM = mongoose.model("Offer", OfferSchema)