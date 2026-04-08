// Bridge domain primitives - branded ID types for type safety

export type BridgeCustomerId = string & { readonly brand: unique symbol }
export type BridgeVirtualAccountId = string & { readonly brand: unique symbol }
export type BridgeExternalAccountId = string & { readonly brand: unique symbol }
export type BridgeTransferId = string & { readonly brand: unique symbol }

// Helper functions to create branded IDs
export const toBridgeCustomerId = (id: string): BridgeCustomerId => {
  return id as BridgeCustomerId
}

export const toBridgeVirtualAccountId = (id: string): BridgeVirtualAccountId => {
  return id as BridgeVirtualAccountId
}

export const toBridgeExternalAccountId = (id: string): BridgeExternalAccountId => {
  return id as BridgeExternalAccountId
}

export const toBridgeTransferId = (id: string): BridgeTransferId => {
  return id as BridgeTransferId
}

// ============ Deposit Address ============

/**
 * Represents a crypto receive address used as the destination for Bridge virtual accounts.
 * Stored in the BridgeDepositAddress collection — not on the Account document —
 * so the chain/currency can change without a schema migration.
 */
export type BridgeDepositAddress = {
  accountId: string
  rail: string           // "ethereum" | "tron" | "solana" | "polygon" | ...
  currency: string       // "usdt" | "usdc" | ...
  address: string        // chain-specific receive address
  ibexReceiveInfoId: string  // IBEX id for balance/sweep queries
}
