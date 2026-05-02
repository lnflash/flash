/**
 * Bridge.xyz API Client
 * Ported from bridge-mcp and extended with Tron/USDT support
 */

import crypto from "crypto"
import { BridgeConfig } from "@config"

import {
  BridgeCustomerId,
  BridgeVirtualAccountId,
  BridgeExternalAccountId,
  BridgeTransferId,
  toBridgeCustomerId,
  toBridgeVirtualAccountId,
  toBridgeExternalAccountId,
  toBridgeTransferId,
} from "@domain/primitives/bridge"

// ============ Error Handling ============

export class BridgeApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public response?: unknown,
  ) {
    super(message)
    this.name = "BridgeApiError"
  }
}

// ============ Request/Response Types ============

export interface CreateIndividualCustomerRequest {
  type: "individual"
  first_name: string
  last_name: string
  email: string
  phone?: string
  residential_address?: {
    street_line_1: string
    street_line_2?: string
    city: string
    subdivision?: string
    postal_code: string
    country: string
  }
  birth_date?: string
  signed_agreement_id?: string
}

export interface CreateBusinessCustomerRequest {
  type: "business"
  business_name: string
  email: string
  phone?: string
  residential_address?: {
    street_line_1: string
    street_line_2?: string
    city: string
    subdivision?: string
    postal_code: string
    country: string
  }
  signed_agreement_id?: string
}

export type CreateCustomerRequest =
  | CreateIndividualCustomerRequest
  | CreateBusinessCustomerRequest

export interface Customer {
  id: string
  type: "individual" | "business"
  status?: "active" | "awaiting_questionnaire" | "rejected" | "paused" | "under_review" | "offboarded" | "awaiting_ubo" | "incomplete" | "not_started"
  has_accepted_terms_of_service?: string
  created_at: string
  updated_at: string
  first_name?: string
  last_name?: string
  email?: string
  business_name?: string
}

export interface KycLink {
  kyc_link: string
  tos_link: string
  customer_id: string
}

// Extended payment rails to include Tron
export type PaymentRail = "ach" | "wire" | "ach_push" | "ach_same_day" | "arbitrum" | "avalanche_c_chain" | "base" | "bre_b" | "co_bank_transfer" | "celo" | "ethereum" | "faster_payments" | "optimism" | "pix" | "polygon" | "sepa" | "solana" | "spei" | "stellar" | "swift" | "tempo" | "tron";

export type VirtualAccountDestinationPaymentRail = "arbitrum" | "avalanche_c_chain" | "base" | "celo" | "ethereum" | "optimism" | "polygon" | "solana" | "stellar" | "tempo" | "tron"


export type SourceCurrency =
  | "usd"
  | "eur"
  | "mxn"
  | "brl"
  | "gbp"
  | "cop"

// Extended currencies to include USDT
export type Currency = "usdb" | "usdt" | "dai" | "pyusd" | "usdc" | "eurc"

export interface CreateVirtualAccountRequest {
  developer_fee_percent?: string
  source: {
    currency: SourceCurrency
  }
  destination: {
    currency: Currency
    payment_rail: VirtualAccountDestinationPaymentRail
    address?: string
    blockchain_memo?: string
    bridge_wallet_id?: string
  }
}

export interface VirtualAccount {
  id: string
  status: string
  customer_id: string
  developer_fee_percent?: string
  source_deposit_instructions: {
    currency: string
    payment_rails: string[]
    bank_name: string
    bank_beneficiary_address: string
    bank_beneficiary_name: string
    bank_account_number: string
    bank_routing_number: string
  }
  destination: {
    currency: string
    payment_rail: string
    address?: string
    blockchain_memo?: string
    bridge_wallet_id?: string
  }
  created_at: string
}

export interface ExternalAccount {
  id: string
  customer_id: string
  account_type: string
  currency: string
  bank_name?: string
  account_number_last_4?: string
  routing_number?: string
  iban?: string
  created_at: string
}

export interface ExternalAccountLinkUrl {
  link_url: string
  expires_at: string
}

export interface ListResponse<T> {
  data: T[]
  has_more: boolean
  cursor?: string
}

export type TrasfertSourceCurrency = "brl" | "cop" | "dai" | "eur" | "eurc" | "gbp" | "mxn" | "pyusd" | "usd" | "usdb" | "usdc" | "usdt"
export interface CreateTransferRequest {
  amount?: string
  currency?: string
  on_behalf_of: string
  developer_fee?: string
  developer_fee_percent?: string
  source: {
    payment_rail: PaymentRail | "bridge_wallet"
    currency: TrasfertSourceCurrency
    from_address?: string
    external_account_id?: string
    bridge_wallet_id?: string
  }
  destination: {
    payment_rail: PaymentRail | "bridge_wallet" | "ach"
    currency: string
    to_address?: string
    external_account_id?: string
    bridge_wallet_id?: string
    wire_message?: string
  }
  dry_run?: boolean
  features?: {
    flexible_amount?: boolean
    static_template?: boolean
    allow_any_from_address?: boolean
  }
}

export interface Transfer {
  id: string
  client_reference_id?: string
  amount: string
  currency: string
  on_behalf_of: string
  developer_fee?: string
  source: {
    payment_rail: string
    currency: string
    from_address?: string
    external_account_id?: string
    bridge_wallet_id?: string
  }
  destination: {
    payment_rail: string
    currency: string
    to_address?: string
    external_account_id?: string
    bridge_wallet_id?: string
  }
  state: string
  source_deposit_instructions?: {
    payment_rail: string
    currency: string
    amount?: string
    bank_name?: string
    bank_address?: string
    bank_account_number?: string
    bank_routing_number?: string
    to_address?: string
  }
  receipt?: Record<string, unknown>
  created_at: string
  updated_at: string
}


export interface BridgeIntiateKyc {
  email: string
  type: "individual" | "business"
  full_name?: string
}

// ============ Bridge Client ============

export class BridgeClient {
  private apiKey: string
  private baseUrl: string

  constructor() {
    this.apiKey = BridgeConfig.apiKey
    this.baseUrl = BridgeConfig.baseUrl || "https://api.sandbox.bridge.xyz/v0"
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = {
      "Api-Key": this.apiKey,
      "Content-Type": "application/json",
    }

    if (idempotencyKey) {
      headers["Idempotency-Key"] = idempotencyKey
    } else {
      headers["Idempotency-Key"] = crypto.randomUUID()
    }


    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })

    const responseData = await response.json().catch(() => null)

    if (!response.ok) {
      throw new BridgeApiError(
        `Bridge API error: ${response.status} ${response.statusText}`,
        response.status,
        responseData,
      )
    }

    return responseData as T
  }

  // ============ Customers ============

  async createCustomer(
    data: CreateCustomerRequest,
    idempotencyKey?: string,
  ): Promise<Customer> {
    return this.request<Customer>("POST", "/customers", data, idempotencyKey)
  }

  async getCustomer(customerId: BridgeCustomerId): Promise<Customer> {
    return this.request<Customer>("GET", `/customers/${customerId}`)
  }

  // ============ KYC ============

  async createKycLink(request: BridgeIntiateKyc, idempotencyKey?: string): Promise<KycLink> {
    return this.request<KycLink>("POST", "/kyc_links", request, idempotencyKey)
  }

  // ============ Virtual Accounts ============

  async createVirtualAccount(
    customerId: BridgeCustomerId,
    data: CreateVirtualAccountRequest,
    idempotencyKey?: string,
  ): Promise<VirtualAccount> {
    return this.request<VirtualAccount>(
      "POST",
      `/customers/${customerId}/virtual_accounts`,
      data,
      idempotencyKey,
    )
  }

  // ============ External Accounts ============

  async getExternalAccountLinkUrl(
    customerId: BridgeCustomerId,
  ): Promise<ExternalAccountLinkUrl> {
    return this.request<ExternalAccountLinkUrl>(
      "POST",
      `/customers/${customerId}/external_accounts/link`,
    )
  }

  async listExternalAccounts(
    customerId: BridgeCustomerId,
  ): Promise<ListResponse<ExternalAccount>> {
    return this.request<ListResponse<ExternalAccount>>(
      "GET",
      `/customers/${customerId}/external_accounts`,
    )
  }

  // ============ Transfers ============

  async createTransfer(
    customerId: BridgeCustomerId,
    data: CreateTransferRequest,
    idempotencyKey?: string,
  ): Promise<Transfer> {
    // Note: Bridge API expects on_behalf_of in the body, not in the path
    const bodyWithCustomer = {
      ...data,
      on_behalf_of: customerId,
    }
    return this.request<Transfer>("POST", "/transfers", bodyWithCustomer, idempotencyKey)
  }

  async getTransfer(
    customerId: BridgeCustomerId,
    transferId: BridgeTransferId,
  ): Promise<Transfer> {
    // Note: Bridge API uses /transfers/{id} not /customers/{id}/transfers/{id}
    return this.request<Transfer>("GET", `/transfers/${transferId}`)
  }
}

export default new BridgeClient()
