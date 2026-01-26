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
