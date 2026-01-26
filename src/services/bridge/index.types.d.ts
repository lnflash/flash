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
  readonly status: "pending" | "processing" | "completed" | "failed" | "cancelled"
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
    readonly transferId: BridgeTransferId
    readonly customerId: BridgeCustomerId
    readonly amount: number
    readonly currency: string
    readonly completedAt: string
  }
}

interface BridgeTransferFailedEvent extends BridgeWebhookEvent {
  readonly type: "transfer.failed"
  readonly data: {
    readonly transferId: BridgeTransferId
    readonly customerId: BridgeCustomerId
    readonly reason: string
    readonly failedAt: string
  }
}

type BridgeWebhookEventType =
  | BridgeKycApprovedEvent
  | BridgeKycRejectedEvent
  | BridgeDepositCompletedEvent
  | BridgeTransferCompletedEvent
  | BridgeTransferFailedEvent
