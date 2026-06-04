export enum BridgeTransferRequestTransactionType {
  Topup = "Topup",
  Cashout = "Cashout",
}

export enum BridgeTransferRequestStatus {
  Pending = "Pending",
  FiatReceived = "Fiat Received",
  Settled = "Settled",
  Completed = "Completed",
  Failed = "Failed",
}

export type BridgeTransferRequestInput = {
  requestId: string
  transactionType: BridgeTransferRequestTransactionType
  status: BridgeTransferRequestStatus
  amount: string
  currency: string
  provider?: "Bridge"
  asset?: string
  network?: string
  developerFee?: string
  initialAmount?: string
  subtotalAmount?: string
  finalAmount?: string
  accountId?: AccountId | string
  walletId?: WalletId | string
  bridgeCustomerId?: string
  bridgeTransferId?: string
  ibexTxHash?: string
  address?: string
  sourceEventId?: string
  sourceEventType?: string
  sourceSystemsSeen?: string[]
  firstSeenAt?: string
  lastSeenAt?: string
  rawPayload?: unknown
  failureReason?: string
}

export class BridgeTransferRequest {
  static doctype = "Bridge Transfer Request"
  readonly input: BridgeTransferRequestInput

  constructor(input: BridgeTransferRequestInput) {
    this.input = input
  }

  toErpnext() {
    const sourceSystemsSeen = [...new Set(this.input.sourceSystemsSeen ?? [])].join(",")

    return {
      doctype: BridgeTransferRequest.doctype,
      request_id: this.input.requestId,
      transaction_type: this.input.transactionType,
      status: this.input.status,
      provider: this.input.provider ?? "Bridge",
      asset: this.input.asset ?? "USDT",
      network: this.input.network ?? "Ethereum",
      amount: this.input.amount,
      currency: this.input.currency,
      developer_fee: this.input.developerFee,
      initial_amount: this.input.initialAmount,
      subtotal_amount: this.input.subtotalAmount,
      final_amount: this.input.finalAmount,
      account_id: this.input.accountId,
      wallet_id: this.input.walletId,
      bridge_customer_id: this.input.bridgeCustomerId,
      bridge_transfer_id: this.input.bridgeTransferId,
      ibex_tx_hash: this.input.ibexTxHash,
      address: this.input.address,
      source_event_id: this.input.sourceEventId,
      source_event_type: this.input.sourceEventType,
      source_systems_seen: sourceSystemsSeen || undefined,
      first_seen_at: this.input.firstSeenAt,
      last_seen_at: this.input.lastSeenAt ?? new Date().toISOString(),
      raw_payload_json:
        this.input.rawPayload === undefined
          ? undefined
          : JSON.stringify(this.input.rawPayload),
      failure_reason: this.input.failureReason,
    }
  }
}
