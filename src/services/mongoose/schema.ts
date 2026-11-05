import crypto from "crypto"

import type { DeviceBootstrapJournalRecord } from "@domain/accounts/device-bootstrap"

import {
  getDefaultAccountsConfig,
  getFeesConfig,
  getDefaultFCMTopics,
  Levels,
} from "@config"
import { AccountStatus, UsernameRegex } from "@domain/accounts"
import { WalletIdRegex, WalletType } from "@domain/wallets"
import { WalletCurrency } from "@domain/shared"
import mongoose from "mongoose"

import { Languages } from "@domain/users"

import { WalletRecord } from "./wallets"

// TODO migration:
// rename InvoiceUser collection to walletInvoice

// mongoose.set("debug", true)

const Schema = mongoose.Schema

// Bridge Record Interfaces
interface IBridgeVirtualAccountRecord {
  accountId: string
  bridgeVirtualAccountId: string
  bankName: string
  routingNumber: string
  accountNumber: string
  accountNumberLast4: string
  createdAt: Date
}

interface IBridgeExternalAccountRecord {
  accountId: string
  bridgeExternalAccountId: string
  bankName: string
  accountNumberLast4: string
  status: "pending" | "verified" | "failed"
  isDefault: boolean
  createdAt: Date
  updatedAt: Date
}

interface IBridgeWithdrawalRecord {
  accountId: string
  bridgeTransferId?: string
  bridgeDepositAddress?: string
  ibexPayoutId?: string
  ibexTxHash?: string
  cryptoSendState?: "not_dispatched" | "attempted"
  cryptoSendAttemptId?: string
  cryptoSendAttemptedAt?: Date
  cryptoSendReviewedAt?: Date
  cryptoSendSourceWalletId?: string
  cryptoSendInfoId?: string
  cryptoSendAmount?: string
  amount: string
  currency: string
  status:
    | "pending"
    | "submitted"
    | "usdt_sent"
    | "send_failed"
    | "send_unknown"
    | "completed"
    | "failed"
    | "cancelled"
  flashFeePercent: string
  flashFee: string
  estimatedBridgeFeePercent: string
  estimatedBridgeFee: string
  estimatedGasBuffer: string
  estimatedCustomerFee: string
  bridgeDeveloperFee?: string
  bridgeExchangeFee?: string
  subtotalAmount?: string
  finalAmount?: string
  failureReason?: string
  externalAccountId: string
  createdAt: Date
  updatedAt: Date
}

const dbMetadataSchema = new Schema<DbMetadataRecord>({
  routingFeeLastEntry: Date, // TODO: rename to routingRevenueLastEntry
})
export const DbMetadata = mongoose.model("DbMetadata", dbMetadataSchema)

const walletInvoiceSchema = new Schema<WalletInvoiceRecord>({
  _id: { type: String }, // hash of invoice
  walletId: {
    required: true,
    type: String,
    validate: {
      validator: function (v: string) {
        return v.match(WalletIdRegex)
      },
    },
  },

  // Usd quote. sats is attached in the invoice directly.
  // this is the option price given by the dealer
  // is optional, BTC wallet or invoice on USD with no amount doesn't have cents
  cents: {
    type: Number,
    validate: {
      validator: Number.isInteger,
      message: "{VALUE} is not an integer value",
    },
  },

  secret: {
    required: true,
    type: String,
    length: 64,
  },

  currency: {
    required: true,
    type: String,
    enum: Object.values(WalletCurrency),
  },

  timestamp: {
    type: Date,
    default: Date.now,
  },

  selfGenerated: {
    type: Boolean,
    default: true,
  },

  pubkey: {
    type: String,
    required: true,
  },

  paid: {
    type: Boolean,
    default: false,
  },
})

walletInvoiceSchema.index({ walletId: 1, paid: 1 })

export const WalletInvoice = mongoose.model<WalletInvoiceRecord>(
  "InvoiceUser",
  walletInvoiceSchema,
)

const feesConfig = getFeesConfig()

const WalletSchema = new Schema<WalletRecord>({
  id: {
    type: String,
    index: true,
    unique: true,
    required: true,
    default: () => crypto.randomUUID(),
  },
  _accountId: {
    type: Schema.Types.ObjectId,
    ref: "Account",
    index: true,
    required: true,
  },
  type: {
    type: String,
    enum: Object.values(WalletType),
    required: true,
    default: WalletType.Checking,
  },
  currency: {
    type: String,
    enum: Object.values(WalletCurrency),
    required: true,
    default: WalletCurrency.Btc,
  },
  onchain: {
    type: [
      {
        pubkey: String,
        address: {
          type: String,
          // TODO: index?
          required: true,
        },
      },
    ],
    default: [],
  },
  lnurlp: {
    type: String,
  },
})

export const Wallet = mongoose.model<WalletRecord>("Wallet", WalletSchema)

const AccountSchema = new Schema<AccountRecord>(
  {
    id: {
      type: String,
      index: true,
      unique: true,
      sparse: true,
      required: true,
      default: () => crypto.randomUUID(),
    },

    withdrawFee: {
      type: Number,
      default: feesConfig.withdrawDefaultMin,
      min: 0,
    },
    created_at: {
      type: Date,
      default: Date.now,
    },
    earn: {
      type: [String],
      default: [],
    },
    role: {
      type: String,
      // FIXME: role is a mix between 2 things here
      // there can be many users and editors
      // there can be only one dealer, bankowner and funder
      // so we may want different property to differentiate those
      enum: ["user", "editor", "dealer", "bankowner", "funder", "rewards"],
      required: true,
      default: "user",
      // TODO : enforce the fact there can be only one dealer/bankowner/funder
    },

    level: {
      type: Number,
      enum: Levels,
    },

    erpParty: {
      type: String,
      required: false,
    },

    kratosUserId: {
      type: String,
      index: true,
      unique: true,
      sparse: true,
    },

    username: {
      type: String,
      match: [UsernameRegex, "Username can only have alphabets, numbers and underscores"],
      minlength: 3,
      maxlength: 50,
      index: {
        unique: true,
        collation: { locale: "en", strength: 2 },
        partialFilterExpression: { username: { $type: "string" } },
      },
    },
    npub: {
      type: String,
      minlength: 63,
      maxlength: 63,
    },
    contactEnabled: {
      type: Boolean,
      default: true,
    },
    contacts: {
      type: [
        {
          id: {
            type: String,
            collation: { locale: "en", strength: 2 },
          },
          name: {
            type: String,
            // TODO: add constraint here
          },
          transactionsCount: {
            type: Number,
            default: 1,
          },
        },
      ],
      default: [],
    },

    title: {
      type: String,
      minlength: 3,
      maxlength: 100,
    },
    coordinates: {
      type: {
        latitude: {
          type: Number,
        },
        longitude: {
          type: Number,
        },
      },
    },

    statusHistory: {
      type: [
        {
          status: {
            type: String,
            required: true,
            enum: Object.values(AccountStatus),
          },
          updatedAt: {
            type: Date,
            default: Date.now,
            required: true,
          },
          updatedByUserId: {
            type: String,
            required: false,
          },
          comment: {
            type: String,
            required: false,
          },
        },
      ],
      default: [
        {
          status: getDefaultAccountsConfig().initialStatus,
          comment: "to be overridden by createAccount",
        },
      ],
    },
    notificationSettings: {
      type: {
        push: {
          type: {
            enabled: {
              type: Boolean,
              default: true,
            },
            disabledCategories: {
              type: [String],
              default: [],
            },
          },
        },
      },
    },

    defaultWalletId: {
      type: String,
      index: true,
    },

    displayCurrency: String, // FIXME: should be an enum

    bridgeCustomerId: {
      type: String,
      required: false,
    },
    bridgeKycStatus: {
      type: String,
      enum: [
        "open",
        "not_started",
        "incomplete",
        "awaiting_questionnaire",
        "awaiting_ubo",
        "under_review",
        "paused",
        "approved",
        "rejected",
        "offboarded",
      ],
      required: false,
    },
    bridgeEthereumAddress: {
      type: String,
      required: false,
    },
  },
  { id: false },
)

AccountSchema.index({
  title: 1,
  coordinates: 1,
})

AccountSchema.index({ bridgeEthereumAddress: 1 }, { sparse: true })

// An npub identifies a customer to the admin/support lookup, so it must resolve
// to exactly one account. `partialFilterExpression` rather than `sparse` — a
// sparse index still indexes documents that hold an explicit `npub: null`, and
// the second such document would collide. Mirrors the `username` index above.
AccountSchema.index(
  { npub: 1 },
  {
    unique: true,
    partialFilterExpression: { npub: { $type: "string" } },
  },
)

export const Account = mongoose.model<AccountRecord>("Account", AccountSchema)

const QuizSchema = new Schema<QuizCompletedRecord>({
  accountId: {
    type: String,
    ref: "Account",
    required: true,
  },
  quizId: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
})

QuizSchema.index({ accountId: 1, quizId: 1 }, { unique: true })

export const Quiz = mongoose.model<QuizCompletedRecord>("Quiz", QuizSchema)

const SupportChatSchema = new Schema<SupportChatRecord>({
  accountId: {
    type: String,
    ref: "Account",
    required: true,
  },
  supportChatId: {
    type: String,
    required: true,
    unique: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
})

export const SupportChat = mongoose.model<SupportChatRecord>(
  "SupportChat",
  SupportChatSchema,
)

const pointSchema = new Schema<LocationRecord>({
  type: {
    type: String,
    enum: ["Point"],
    required: true,
  },
  coordinates: {
    type: [Number],
    required: true,
  },
})

const MerchantSchema = new Schema<MerchantRecord>({
  id: {
    type: String,
    index: true,
    unique: true,
    sparse: true,
    required: true,
    default: () => crypto.randomUUID(),
  },
  username: {
    type: String,
    required: true,
    index: true,
  },
  title: {
    type: String,
    required: true,
  },
  location: {
    type: pointSchema,
    index: "2dsphere",
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  validated: {
    type: Boolean,
    default: false,
    index: true,
  },
})

export const Merchant = mongoose.model<MerchantRecord>("Merchant", MerchantSchema)

const AccountIpsSchema = new Schema<AccountIpsRecord>({
  ip: {
    type: String,
    required: true,
  },
  metadata: {
    type: {
      provider: String,
      country: String,
      isoCode: String,
      region: String,
      city: String,
      //using Type instead of type due to its special status in mongoose
      Type: String,
      asn: String,
      proxy: Boolean,
    },
  },
  firstConnection: {
    type: Date,
    default: Date.now,
  },
  lastConnection: Date,
  _accountId: {
    type: Schema.Types.ObjectId,
    ref: "Account",
    index: true,
    required: true,
  },
})

export const AccountIps = mongoose.model<AccountIpsRecord>("AccountIp", AccountIpsSchema)

AccountIpsSchema.index({
  _accountId: 1,
  ip: 1,
})

const UserSchema = new Schema(
  {
    createdAt: {
      type: Date,
      default: Date.now,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    language: {
      type: String,
      enum: [...Languages, ""],
      default: "",
    },
    deviceTokens: {
      type: [String],
      default: [],
    },
    notificationTopics: {
      type: [String],
      default: getDefaultFCMTopics(),
    },
    phoneMetadata: {
      type: {
        carrier: {
          error_code: String, // check this is the right syntax
          mobile_country_code: String,
          mobile_network_code: String,
          name: String,
          type: {
            types: String,
            enum: ["landline", "voip", "mobile"],
          },
        },
        countryCode: String,
      },
      default: undefined,
    },
    phone: {
      type: String,
      index: true,
      unique: true,
      sparse: true,
    },
    deletedPhones: {
      type: [String],
    },
    deviceId: {
      type: String,
    },
    deletedEmail: {
      type: [String],
    },
  },
  { id: false },
)

export const User = mongoose.model<UserRecord>("User", UserSchema)

const paymentFlowStateSchema = new Schema<PaymentFlowStateRecord>(
  {
    senderWalletId: { type: String, required: true },
    senderWalletCurrency: { type: String, required: true },
    senderAccountId: { type: String, required: true },
    settlementMethod: { type: String, required: true },
    paymentInitiationMethod: { type: String, required: true },
    paymentHash: String,
    intraLedgerHash: String,
    createdAt: { type: Date, required: true },
    paymentSentAndPending: { type: Boolean, required: true },
    descriptionFromInvoice: String,

    btcPaymentAmount: { type: Number, required: true },
    usdPaymentAmount: { type: Number, required: true },
    inputAmount: { type: Number, required: true },

    btcProtocolAndBankFee: { type: Number, required: true },
    usdProtocolAndBankFee: { type: Number, required: true },

    recipientWalletId: String,
    recipientWalletCurrency: String,
    recipientAccountId: String,
    recipientPubkey: String,
    recipientUsername: String,
    recipientUserId: String,

    outgoingNodePubkey: String,
    cachedRoute: Schema.Types.Mixed,
  },
  { id: false },
)

paymentFlowStateSchema.index({
  paymentHash: 1,
})

export const PaymentFlowState = mongoose.model(
  "Payment_Flow_State",
  paymentFlowStateSchema,
)

const WalletOnChainPendingReceiveSchema = new Schema<WalletOnChainPendingReceiveRecord>(
  {
    walletId: { type: String, required: true },
    address: { type: String, required: true },
    transactionHash: { type: String, required: true },
    vout: { type: Number, required: true },
    walletAmount: { type: Number, required: true },
    walletFee: { type: Number, required: true },
    walletCurrency: { type: String, required: true },

    displayAmount: { type: String, required: true },
    displayFee: { type: String, required: true },
    displayPriceBase: { type: String, required: true },
    displayPriceOffset: { type: String, required: true },
    displayPriceCurrency: { type: String, required: true },

    createdAt: { type: Date, default: Date.now },
  },
  { id: false },
)

WalletOnChainPendingReceiveSchema.index({ walletId: 1, createdAt: -1 })
WalletOnChainPendingReceiveSchema.index({ transactionHash: 1, vout: 1 }, { unique: true })

export const WalletOnChainPendingReceive =
  mongoose.model<WalletOnChainPendingReceiveRecord>(
    "WalletOnChainPendingReceive",
    WalletOnChainPendingReceiveSchema,
  )

const CashWalletCutoverConfigSchema = new Schema<CashWalletCutoverConfigRecord>({
  _id: { type: String, default: "cash_wallet_cutover" },
  state: { type: String, enum: ["pre", "in_progress", "complete"], required: true },
  scheduledAt: Date,
  startedAt: Date,
  completedAt: Date,
  pausedAt: Date,
  pauseReason: String,
  updatedBy: String,
  cutoverVersion: { type: Number, required: true, default: 1 },
  runId: String,
  updatedAt: { type: Date, default: Date.now },
})

export const CashWalletCutoverConfig = mongoose.model<CashWalletCutoverConfigRecord>(
  "CashWalletCutoverConfig",
  CashWalletCutoverConfigSchema,
)

const CashWalletMigrationSchema = new Schema<CashWalletMigrationRecord>({
  _id: { type: String, required: true },
  accountId: { type: String, required: true, index: true },
  accountUuid: String,
  legacyUsdWalletId: { type: String, required: true },
  destinationUsdtWalletId: { type: String, required: true },
  previousDefaultWalletId: String,
  cutoverVersion: { type: Number, required: true, index: true },
  runId: { type: String, required: true, index: true },
  status: { type: String, required: true, index: true },
  sourceBalanceUsdCents: String,
  destinationAmountUsdtMicros: String,
  destinationStartingBalanceUsdtMicros: String,
  feeAmountUsdCents: String,
  feeAmountUsdtMicros: String,
  balanceMoveInvoicePaymentRequest: String,
  balanceMoveInvoicePaymentHash: String,
  balanceMovePaymentTransactionId: String,
  feeReimbursementInvoicePaymentRequest: String,
  feeReimbursementInvoicePaymentHash: String,
  feeReimbursementPaymentTransactionId: String,
  estimatedFee: Boolean,
  idempotencyKey: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  lastError: String,
  lockedAt: Date,
  lockedBy: String,
  startedAt: Date,
  completedAt: Date,
  updatedAt: { type: Date, default: Date.now, index: true },
  rollbackRequestedAt: Date,
  rollbackRequestedBy: String,
  rollbackReason: String,
  rollbackFromStatus: String,
  rollbackPointerRestoredAt: Date,
  rollbackInvoicePaymentRequest: String,
  rollbackInvoicePaymentHash: String,
  rollbackPaymentTransactionId: String,
  rollbackShortfallUsdtMicros: String,
  rollbackShortfallInvoicePaymentRequest: String,
  rollbackShortfallInvoicePaymentHash: String,
  rollbackShortfallPaymentTransactionId: String,
  rolledBackAt: Date,
})

CashWalletMigrationSchema.index({ accountId: 1, runId: 1 }, { unique: true })
CashWalletMigrationSchema.index({ idempotencyKey: 1 }, { unique: true })
CashWalletMigrationSchema.index({ cutoverVersion: 1, status: 1, updatedAt: 1 })
CashWalletMigrationSchema.index({ runId: 1, status: 1 })
CashWalletMigrationSchema.index({ lockedAt: 1 })

export const CashWalletMigration = mongoose.model<CashWalletMigrationRecord>(
  "CashWalletMigration",
  CashWalletMigrationSchema,
)

const BridgeVirtualAccountSchema = new Schema<IBridgeVirtualAccountRecord>({
  // unique: true enforces one VA per account at the DB layer — idempotency guard
  accountId: { type: String, required: true, unique: true },
  bridgeVirtualAccountId: { type: String, required: true, unique: true },
  bankName: { type: String, required: true },
  routingNumber: { type: String, required: true },
  accountNumber: { type: String, required: true },
  accountNumberLast4: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
})

const BridgeExternalAccountSchema = new Schema<IBridgeExternalAccountRecord>({
  accountId: { type: String, required: true, index: true },
  bridgeExternalAccountId: { type: String, required: true, unique: true },
  bankName: { type: String, required: true },
  accountNumberLast4: { type: String, required: true },
  status: { type: String, enum: ["pending", "verified", "failed"], default: "pending" },
  isDefault: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
})

// CRIT-2 (ENG-281): Compound index enforces that a given bridgeExternalAccountId
// can only be associated with one accountId at the DB layer, preventing cross-account
// withdrawal attacks even if application-layer ownership checks are bypassed.
BridgeExternalAccountSchema.index(
  { accountId: 1, bridgeExternalAccountId: 1 },
  { unique: true },
)

const BridgeWithdrawalSchema = new Schema<IBridgeWithdrawalRecord>({
  accountId: { type: String, required: true, index: true },
  bridgeTransferId: { type: String, unique: true, sparse: true },
  bridgeDepositAddress: { type: String },
  ibexPayoutId: { type: String, unique: true, sparse: true },
  ibexTxHash: { type: String },
  cryptoSendState: { type: String, enum: ["not_dispatched", "attempted"] },
  cryptoSendAttemptId: { type: String },
  cryptoSendAttemptedAt: { type: Date },
  cryptoSendReviewedAt: { type: Date },
  cryptoSendSourceWalletId: { type: String },
  cryptoSendInfoId: { type: String },
  cryptoSendAmount: { type: String },
  amount: { type: String, required: true },
  currency: { type: String, required: true },
  status: {
    type: String,
    enum: [
      "pending",
      "submitted",
      "usdt_sent",
      "send_failed",
      "send_unknown",
      "completed",
      "failed",
      "cancelled",
    ],
    default: "pending",
  },
  flashFeePercent: { type: String, required: true },
  flashFee: { type: String, required: true },
  estimatedBridgeFeePercent: { type: String, required: true },
  estimatedBridgeFee: { type: String, required: true },
  estimatedGasBuffer: { type: String, required: true },
  estimatedCustomerFee: { type: String, required: true },
  bridgeDeveloperFee: { type: String },
  bridgeExchangeFee: { type: String },
  subtotalAmount: { type: String },
  finalAmount: { type: String },
  failureReason: { type: String, maxlength: 512 },
  externalAccountId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
})

// At most one pending row per (account, destination, amount, currency). Partial filter must
// not use $exists:false — MongoDB rejects it for partial indexes ("$not ... $exists").
// "pending" alone is enough: completed/failed rows are excluded so the same tuple can repeat
// after a terminal status.
BridgeWithdrawalSchema.index(
  { accountId: 1, externalAccountId: 1, amount: 1, currency: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "pending" },
  },
)

// One unresolved dispatch per account, including concurrent distinct requests.
// The repository also creates/verifies this exact index before any dispatch.
BridgeWithdrawalSchema.index(
  { accountId: 1 },
  {
    unique: true,
    name: "bridge_withdrawal_unresolved_send",
    partialFilterExpression: { status: "send_unknown" },
  },
)

BridgeWithdrawalSchema.index({ status: 1, cryptoSendReviewedAt: 1, _id: 1 })

const BridgeDepositsSchema = new Schema({
  eventId: { type: String, required: true, unique: true },
  transferId: { type: String, required: true },
  customerId: { type: String, required: true },
  state: { type: String, required: true },
  amount: { type: String, required: true },
  currency: { type: String, required: true },
  subtotalAmount: { type: String },
  developerFee: { type: String, required: true, default: "0" },
  initialAmount: { type: String },
  finalAmount: { type: String },
  destinationTxHash: { type: String },
  createdAt: { type: Date, default: Date.now },
})

BridgeDepositsSchema.index({ transferId: 1 })
BridgeDepositsSchema.index({ customerId: 1, createdAt: -1 })

export const BridgeDeposits = mongoose.model("BridgeDeposits", BridgeDepositsSchema)

const IbexCryptoReceiveSchema = new Schema({
  txHash: { type: String, required: true, unique: true },
  address: { type: String, required: true },
  amount: { type: String, required: true },
  currency: { type: String, required: true },
  network: { type: String, required: true },
  accountId: { type: String },
  receivedAt: { type: Date, default: Date.now },
})

IbexCryptoReceiveSchema.index({ receivedAt: -1 })
IbexCryptoReceiveSchema.index({ address: 1, receivedAt: -1 })

export const IbexCryptoReceive = mongoose.model(
  "IbexCryptoReceive",
  IbexCryptoReceiveSchema,
)

const BridgeReconciliationOrphanSchema = new Schema({
  orphanKey: { type: String, required: true, unique: true },
  orphanType: {
    type: String,
    enum: [
      "bridge_without_ibex",
      "ibex_without_bridge",
      "bridge_transfer_without_ibex_send",
      "ibex_send_without_bridge_settlement",
    ],
    required: true,
  },
  status: {
    type: String,
    enum: ["unmatched", "resolved"],
    default: "unmatched",
    required: true,
  },
  transferId: { type: String },
  txHash: { type: String },
  bridgeEventId: { type: String },
  customerId: { type: String },
  amount: { type: String },
  currency: { type: String },
  triageContext: { type: Schema.Types.Mixed, required: true },
  detectedAt: { type: Date, default: Date.now },
  resolvedAt: { type: Date },
})

BridgeReconciliationOrphanSchema.index({ orphanType: 1, detectedAt: -1 })
BridgeReconciliationOrphanSchema.index({ detectedAt: -1 })
BridgeReconciliationOrphanSchema.index({ status: 1, detectedAt: -1 })
BridgeReconciliationOrphanSchema.index({ txHash: 1 })

export const BridgeReconciliationOrphan = mongoose.model(
  "BridgeReconciliationOrphan",
  BridgeReconciliationOrphanSchema,
)

// ENG-653: Flash-native payment splits. One rule = "pay `percent` of every
// trigger-eligible receive on `walletId` to `destinationWalletId`".
const PaymentSplitRuleSchema = new Schema({
  walletId: { type: String, required: true },
  destinationWalletId: { type: String, required: true },
  percent: { type: Number, required: true, min: 1, max: 100 },
  enabled: { type: Boolean, required: true, default: true },
  createdAt: { type: Date, required: true, default: Date.now },
  updatedAt: { type: Date, required: true, default: Date.now },
})

PaymentSplitRuleSchema.index({ walletId: 1, enabled: 1 })

export const PaymentSplitRule = mongoose.model("PaymentSplitRule", PaymentSplitRuleSchema)

// ENG-717: one row per wallet with (or previously with) split rules — the
// Flash-owned IBEX account external receives are minted on so no user wallet
// ever holds the gross. Permanent per wallet (decision 4): created lazily by
// walletSplitsSet, never deleted. After the last rule is deleted the shadow
// keeps its residue, which the split reconcile drains to the merchant.
const SplitReceiveAccountSchema = new Schema({
  // The Flash wallet the shadow backs (Wallet.id == the merchant's own IBEX
  // account id).
  walletId: { type: String, required: true },
  // The shadow IBEX account id.
  ibexAccountId: { type: String, required: true },
  currency: { type: String, required: true },
  // The IBEX LNURL-pay created on the shadow account, served for the wallet's
  // Lightning address while it has enabled rules.
  lnurlp: { type: String },
  createdAt: { type: Date, required: true, default: Date.now },
  updatedAt: { type: Date, required: true, default: Date.now },
})

SplitReceiveAccountSchema.index({ walletId: 1 }, { unique: true })
SplitReceiveAccountSchema.index({ ibexAccountId: 1 }, { unique: true })

export const SplitReceiveAccount = mongoose.model(
  "SplitReceiveAccount",
  SplitReceiveAccountSchema,
)

// One row per (receive, payout target). The unique (triggerKey, legKind,
// destinationWalletId) index is the dedupe between the webhook and the
// reconcile cron, and between webhook replays: a second insert for the same
// receive is a duplicate-key no-op. It is keyed on the payout target, not the
// rule id, because walletSplitsSet replaces every rule with a fresh _id: a
// replay after the merchant re-saves (or deletes and re-adds) the same split
// must still be a duplicate, not a second payout. A wallet's rules never
// repeat a destination (SplitDuplicateDestinationError), and a receive has
// exactly one net leg, so the legKind in the key keeps the net leg from
// colliding with a share leg to the same wallet.
//
// v1 rows carried no legKind and a (triggerKey, walletId, destinationWalletId)
// unique index; every v1 row is terminal in prod, so the 2026-10 migration
// drops the old index and this schema declares the replacement.
const PaymentSplitExecutionSchema = new Schema({
  triggerKey: { type: String, required: true },
  ruleId: { type: String, required: true },
  // Which leg of the settle this row pays.
  legKind: {
    type: String,
    enum: ["share", "net"],
    required: true,
  },
  walletId: { type: String, required: true },
  // The shadow receive account the leg is paid FROM (the IBEX account the
  // receive settled on).
  sourceIbexAccountId: { type: String, required: true },
  destinationWalletId: { type: String, required: true },
  currency: { type: String, required: true },
  // The gross receive amount in the source wallet's minor units
  // (cents / micros).
  grossMinor: { type: String, required: true },
  shareCents: { type: Number, required: true },
  status: {
    type: String,
    enum: ["pending", "sending", "sent", "ibex_pending", "failed", "unknown"],
    required: true,
  },
  attempts: { type: Number, required: true, default: 0 },
  nextAttemptAt: { type: Date, required: true, default: Date.now },
  lastError: { type: String },
  createdAt: { type: Date, required: true, default: Date.now },
  updatedAt: { type: Date, required: true, default: Date.now },
})

PaymentSplitExecutionSchema.index(
  { triggerKey: 1, legKind: 1, destinationWalletId: 1 },
  { unique: true },
)
PaymentSplitExecutionSchema.index({ status: 1, nextAttemptAt: 1 })

export const PaymentSplitExecution = mongoose.model(
  "PaymentSplitExecution",
  PaymentSplitExecutionSchema,
)

// Payment hashes of invoices Flash minted for itself: the recipient side of an
// intraledger send (P2P, Fygaro top-up credits, referral payouts, split
// payouts) and of cash-wallet cutover moves, plus every bolt11 / LNURL a Flash
// user pays (the payee may be another Flash wallet). A receive whose hash is
// here never triggers payment splits. TTL must stay above the split reconcile
// lookback (cronIntervalMs plus margin).
export const INTERNAL_TRANSFER_INVOICE_TTL_SECONDS = 30 * 24 * 60 * 60

const InternalTransferInvoiceSchema = new Schema({
  paymentHash: { type: String, required: true },
  senderWalletId: { type: String },
  // Unknown for ln-send / lnurl-send: Flash only knows the payer.
  recipientWalletId: { type: String },
  origin: {
    type: String,
    enum: ["intraledger", "cutover", "ln-send", "lnurl-send", "split"],
    required: true,
  },
  createdAt: { type: Date, required: true, default: Date.now },
})

// One marker per (hash, sender, origin), not per hash: two Flash wallets may
// pay the same bolt11, and each must own a row it alone can withdraw when its
// own payment is rejected. A hash is internal while ANY row for it exists
// (isInternalTransferInvoice), served by this index's paymentHash prefix.
// Rows without a sender (cutover) index senderWalletId as null, so a repeat
// of the same hash and origin still collapses to one row.
InternalTransferInvoiceSchema.index(
  { paymentHash: 1, senderWalletId: 1, origin: 1 },
  { unique: true },
)

InternalTransferInvoiceSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: INTERNAL_TRANSFER_INVOICE_TTL_SECONDS },
)

export const InternalTransferInvoice = mongoose.model(
  "InternalTransferInvoice",
  InternalTransferInvoiceSchema,
)

const BridgeReplaySchema = new Schema({
  eventId: { type: String, required: true },
  eventType: { type: String, required: true },
  eventPayload: { type: Schema.Types.Mixed, required: true },
  bridgeEventCreatedAt: { type: Date, required: true },
  replayedAt: { type: Date, required: true, default: Date.now },
  operator: { type: String, required: true },
  timeWindowStart: { type: Date, required: true },
  timeWindowEnd: { type: Date, required: true },
  httpStatus: { type: Number, required: true },
  httpResponse: { type: Schema.Types.Mixed, required: true },
  dryRun: { type: Boolean, required: true, default: false },
})

BridgeReplaySchema.index({ eventId: 1 })
BridgeReplaySchema.index({ replayedAt: -1 })
BridgeReplaySchema.index({ eventType: 1, replayedAt: -1 })

export const BridgeReplay = mongoose.model("BridgeReplay", BridgeReplaySchema)

export const BridgeVirtualAccount = mongoose.model<IBridgeVirtualAccountRecord>(
  "BridgeVirtualAccount",
  BridgeVirtualAccountSchema,
)

export const BridgeExternalAccount = mongoose.model<IBridgeExternalAccountRecord>(
  "BridgeExternalAccount",
  BridgeExternalAccountSchema,
)

export const BridgeWithdrawal = mongoose.model<IBridgeWithdrawalRecord>(
  "BridgeWithdrawal",
  BridgeWithdrawalSchema,
)

const DeviceBootstrapSlotSchema = new Schema(
  {
    state: {
      type: String,
      required: true,
      enum: ["planned", "dispatching", "known", "attached", "blocked"],
    },
    attemptId: String,
    providerId: String,
    origin: { type: String, enum: ["created", "local"] },
  },
  { _id: false },
)

const DeviceAccountBootstrapSchema = new Schema<DeviceBootstrapJournalRecord>(
  {
    _id: { type: String, required: true },
    version: { type: Number, required: true, enum: [1] },
    userId: { type: String, required: true },
    accountId: { type: String, required: true, index: true },
    mode: { type: String, required: true, enum: ["new", "legacy-local"] },
    phase: { type: String, required: true, enum: ["initializing", "ready"] },
    wallets: {
      USD: { type: DeviceBootstrapSlotSchema, required: true },
      USDT: { type: DeviceBootstrapSlotSchema, required: true },
    },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  { versionKey: false },
)

// The immutable hash primary key is the only uniqueness dependency. No legacy
// User/device index is created and no credential/token is stored here.
export const DeviceAccountBootstrap = mongoose.model<DeviceBootstrapJournalRecord>(
  "DeviceAccountBootstrap",
  DeviceAccountBootstrapSchema,
)
