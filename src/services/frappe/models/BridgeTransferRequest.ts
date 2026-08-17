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

// Marker written into `source_systems_seen` when a row's account_id was
// resolved from the checkout payer email rather than from customReference.
// That input is payer-typed and identity-unverified, so rows carrying this
// marker are DISPLAY-ONLY: no gate may read their account_id (see
// ErpNext.sumFygaroTopupGrossCentsSince). Writer and reader share the
// constant so the two can never drift on the spelling.
//
// ⚠️ READ BEFORE ADDING ANY NEW READER OF `account_id` ON A FYGARO ROW.
// This overloads a provenance list with a TRUST CLAIM, which means
// `account_id` on a Fygaro Topup row is either "verified via
// customReference" or "typed by whoever held the card" — and nothing in the
// type system distinguishes them. Every gate, report, threshold or credit
// path that reads `account_id` MUST call `isEmailAttributedRow` on the row's
// `source_systems_seen` first and treat a marked row as unattributed.
// Today exactly one reader does (the daily-cap sum); a second one that
// forgets would silently trust payer-typed input.
//
// The clean design is a separate column (`account_id_unverified`, or an
// `attribution_source` Select) so `account_id` keeps one meaning and neither
// the cap exemption nor the un-sticking logic in `applyUpdateGuards` needs to
// exist. That was a deliberate trade, not an oversight: the ERPNext admin
// page derives the displayed username FROM `account_id`, so splitting the
// field means changing the Bridge Transfer Request doctype and its
// payer-identity join in lockstep (frappe-flash-admin: collect_lookup_refs /
// match_account_identity / build_payer_fields). Tracked for follow-up.
export const EMAIL_ATTRIBUTION_SOURCE_SYSTEM = "email_attribution"

export type BridgeTransferRequestInput = {
  requestId: string
  transactionType: BridgeTransferRequestTransactionType
  status: BridgeTransferRequestStatus
  amount: string
  currency: string
  provider?: "Bridge" | "Fygaro"
  asset?: string
  network?: string
  developerFee?: string
  initialAmount?: string
  subtotalAmount?: string
  finalAmount?: string
  processorFee?: string
  flashFee?: string
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

export const toFrappeDatetime = (value?: string): string => {
  const date = value ? new Date(value) : new Date()

  if (Number.isNaN(date.getTime())) return value ?? ""

  const pad = (part: number) => String(part).padStart(2, "0")

  return [
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`,
  ].join(" ")
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
      processor_fee: this.input.processorFee,
      flash_fee: this.input.flashFee,
      account_id: this.input.accountId,
      wallet_id: this.input.walletId,
      bridge_customer_id: this.input.bridgeCustomerId,
      bridge_transfer_id: this.input.bridgeTransferId,
      ibex_tx_hash: this.input.ibexTxHash,
      address: this.input.address,
      source_event_id: this.input.sourceEventId,
      source_event_type: this.input.sourceEventType,
      source_systems_seen: sourceSystemsSeen || undefined,
      first_seen_at: this.input.firstSeenAt
        ? toFrappeDatetime(this.input.firstSeenAt)
        : undefined,
      last_seen_at: toFrappeDatetime(this.input.lastSeenAt),
      raw_payload_json:
        this.input.rawPayload === undefined
          ? undefined
          : JSON.stringify(this.input.rawPayload),
      failure_reason: this.input.failureReason,
    }
  }
}
