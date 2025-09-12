export { InviteStatus, InviteMethod } from "@services/mongoose/models/invite"
export type { InviteRecord } from "@services/mongoose/models/invite"

export const INVITE_EXPIRY_HOURS = 24
export const DAILY_INVITE_LIMIT = 10
export const TARGET_INVITE_LIMIT = 3