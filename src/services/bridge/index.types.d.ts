import {
  BridgeCustomerId,
  BridgeVirtualAccountId,
  BridgeExternalAccountId,
  BridgeTransferId,
} from "@domain/primitives/bridge"

// Bridge API Service Types - Response models from Bridge API

interface BridgeCustomer {
  readonly id: BridgeCustomerId
  readonly externalId?: string
  readonly email?: string
  readonly name?: string
  readonly createdAt: string
  readonly updatedAt: string
}

interface BridgeVirtualAccount {
  readonly id: BridgeVirtualAccountId
  readonly customerId: BridgeCustomerId
  readonly accountNumber: string
  readonly routingNumber: string
  readonly bankName: string
  readonly currency: string
  readonly status: "active" | "inactive" | "closed"
  readonly createdAt: string
  readonly updatedAt: string
}

interface BridgeExternalAccount {
  readonly id: BridgeExternalAccountId
  readonly customerId: BridgeCustomerId
  readonly accountNumber: string
  readonly routingNumber: string
  readonly accountHolderName: string
  readonly bankName: string
  readonly accountType: "checking" | "savings"
  readonly status: "pending" | "verified" | "failed"
  readonly createdAt: string
  readonly updatedAt: string
}

interface BridgeTransfer {
  readonly id: BridgeTransferId
  readonly customerId: BridgeCustomerId
  readonly sourceAccountId: BridgeVirtualAccountId | BridgeExternalAccountId
  readonly destinationAccountId: BridgeVirtualAccountId | BridgeExternalAccountId
  readonly amount: number
  readonly currency: string
  readonly status:
    | "awaiting_funds"
    | "in_review"
    | "funds_received"
    | "payment_submitted"
    | "payment_processed"
    | "undeliverable"
    | "returned"
    | "refund_in_flight"
    | "refunded"
    | "refund_failed"
    | "missing_return_policy"
    | "error"
    | "canceled"
  readonly description?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly completedAt?: string
}

// Webhook Event Types

interface BridgeWebhookEvent {
  readonly id: string
  readonly type: string
  readonly timestamp: string
  readonly data: Record<string, unknown>
}

interface BridgeKycApprovedEvent extends BridgeWebhookEvent {
  readonly type: "kyc.approved"
  readonly data: {
    readonly customerId: BridgeCustomerId
    readonly approvedAt: string
  }
}

interface BridgeKycRejectedEvent extends BridgeWebhookEvent {
  readonly type: "kyc.rejected"
  readonly data: {
    readonly customerId: BridgeCustomerId
    readonly reason: string
    readonly rejectedAt: string
  }
}

interface BridgeDepositCompletedEvent extends BridgeWebhookEvent {
  readonly type: "deposit.completed"
  readonly data: {
    readonly transferId: BridgeTransferId
    readonly customerId: BridgeCustomerId
    readonly amount: number
    readonly currency: string
    readonly completedAt: string
  }
}

interface BridgeTransferCompletedEvent extends BridgeWebhookEvent {
  readonly type: "transfer.completed"
  readonly data: {
    readonly transfer_id: BridgeTransferId
    readonly customerId: BridgeCustomerId
    readonly state: "payment_processed"
    readonly amount: string
    readonly currency: string
  }
}

interface BridgeTransferPaymentProcessedEvent extends BridgeWebhookEvent {
  readonly type: "transfer.payment_processed"
  readonly data: {
    readonly transfer_id: BridgeTransferId
    readonly customerId: BridgeCustomerId
    readonly state: "payment_processed"
    readonly amount: string
    readonly currency: string
  }
}

interface BridgeTransferFailedEvent extends BridgeWebhookEvent {
  readonly type: "transfer.failed"
  readonly data: {
    readonly transfer_id: BridgeTransferId
    readonly customerId: BridgeCustomerId
    readonly state:
      | "undeliverable"
      | "returned"
      | "refunded"
      | "refund_in_flight"
      | "refund_failed"
      | "missing_return_policy"
      | "error"
      | "canceled"
    readonly reason?: string
    readonly return_reason?: string
    readonly amount: string
    readonly currency: string
  }
}

type BridgeWebhookEventType =
  | BridgeKycApprovedEvent
  | BridgeKycRejectedEvent
  | BridgeDepositCompletedEvent
  | BridgeTransferCompletedEvent
  | BridgeTransferPaymentProcessedEvent
  | BridgeTransferFailedEvent
