export { InviteStatus, InviteMethod } from "@services/mongoose/models/invite"
export type { InviteRecord } from "@services/mongoose/models/invite"

export const INVITE_EXPIRY_HOURS = 24
export const DAILY_INVITE_LIMIT = 10
export const TARGET_INVITE_LIMIT = 3

// Branded type for InviteId
export type InviteId = string & { readonly brand: unique symbol }

// Helper function to convert string to InviteId
export const checkedToInviteId = (inviteId: string): InviteId => {
  // Basic validation - should be a 24-character MongoDB ObjectId
  if (inviteId.length !== 24) {
    throw new Error(`Invalid invite ID format: ${inviteId}`)
  }
  return inviteId as InviteId
}
