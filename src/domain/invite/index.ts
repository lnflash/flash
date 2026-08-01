export { InviteStatus, InviteMethod } from "@services/mongoose/models/invite"
export type { InviteRecord } from "@services/mongoose/models/invite"
export { validateEmail, validatePhone, validateContactForMethod } from "./validation"

import { ValidationError } from "@domain/shared"

export const INVITE_EXPIRY_HOURS = 24
export const DAILY_INVITE_LIMIT = 10
export const TARGET_INVITE_LIMIT = 3
export const NEW_USER_INVITE_WINDOW_HOURS = 24 // New users can redeem invites within this window after account creation
export const INVITE_TOKEN_LENGTH = 40 // 20 bytes = 40 hex characters

// Branded type for InviteId
export type InviteId = string & { readonly brand: unique symbol }

// Domain-specific error for invite validation
export class InvalidInviteIdError extends ValidationError {}
export class InviteAlreadyAcceptedError extends ValidationError {}
export class InvalidExpirationDateError extends ValidationError {}

// Helper function to convert string to InviteId
export const checkedToInviteId = (inviteId: string): InviteId | ValidationError => {
  // Basic validation - should be a 24-character MongoDB ObjectId
  if (inviteId.length !== 24) {
    return new InvalidInviteIdError(`Invalid invite ID format: ${inviteId}`)
  }
  return inviteId as InviteId
}

// Branded type for InviteToken
export type InviteToken = string & { readonly brand: unique symbol }

// Helper function to validate invite token format
export const checkedToInviteToken = (token: string): InviteToken | ValidationError => {
  if (!token || token.length !== INVITE_TOKEN_LENGTH) {
    return new ValidationError("Invalid invitation token length")
  }
  if (!/^[a-f0-9]+$/i.test(token)) {
    return new ValidationError("Invalid invitation token format")
  }
  return token as InviteToken
}
