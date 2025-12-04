/**
 * Business Account Upgrade Request Module
 *
 * This module handles requests from users to upgrade their account level.
 * It creates a structured record in ERPNext's "Account Upgrade Request" doctype
 * for tracking and approval workflows.
 *
 * Data sources:
 * - MongoDB (Account): username, current level
 * - MongoDB (User): phone number
 * - Kratos (Identity): email
 * - GraphQL mutation input: fullName, business details, bank details, etc.
 *
 * The ERPNext doctype stores all this information for admin review.
 */
import { InvalidAccountStatusError } from "@domain/errors"
import { checkedToAccountLevel } from "@domain/accounts"
import { AccountsRepository, UsersRepository } from "@services/mongoose"
import { IdentityRepository } from "@services/kratos"
import ErpNext from "@services/frappe/ErpNext"
import { updateAccountLevel } from "./update-account-level"

/**
 * Input from the GraphQL mutation
 *
 * Required fields:
 * - accountId: From authenticated context (domainAccount.id)
 * - level: Target account level (2 = Pro, 3 = Merchant)
 * - fullName: User's legal name (for KYC/verification)
 *
 * Optional fields (for business verification):
 * - businessName, businessAddress: Business details
 * - terminalRequested: Whether user wants a POS terminal
 * - bankName, bankBranch, accountType, currency, accountNumber: Bank account for settlements
 * - idDocument: Reference to uploaded ID document
 */
type BusinessUpgradeRequestInput = {
  accountId: AccountId
  level: number
  fullName: string
  businessName?: string
  businessAddress?: string
  terminalRequested?: boolean
  bankName?: string
  bankBranch?: string
  accountType?: string
  currency?: string
  accountNumber?: number
  idDocument?: string
}

/**
 * Request an account level upgrade with business information.
 *
 * Creates an Account Upgrade Request document in ERPNext with structured data.
 *
 * Behavior by level:
 * - Level 2 (Pro): Creates request AND auto-upgrades account immediately
 * - Level 3 (Merchant): Creates request only, requires manual admin approval
 *
 * @param input - Business upgrade request data
 * @returns Success or an error
 */
export const businessAccountUpgradeRequest = async (
  input: BusinessUpgradeRequestInput,
): Promise<true | ApplicationError> => {
  const {
    accountId,
    level,
    fullName,
    businessName,
    businessAddress,
    terminalRequested,
    bankName,
    bankBranch,
    accountType,
    currency,
    accountNumber,
    idDocument,
  } = input

  const accountsRepo = AccountsRepository()
  const usersRepo = UsersRepository()

  // Get account details
  const account = await accountsRepo.findById(accountId)
  if (account instanceof Error) return account

  // Validate requested level
  const checkedLevel = checkedToAccountLevel(level)
  if (checkedLevel instanceof Error) return checkedLevel

  // Prevent downgrade requests
  if (checkedLevel < account.level) {
    return new InvalidAccountStatusError("Cannot request account level downgrade")
  }

  // Short-circuit if no change needed
  if (checkedLevel === account.level) {
    return new InvalidAccountStatusError("Account is already at requested level")
  }

  // Fetch user's phone number from MongoDB User collection
  const user = await usersRepo.findById(account.kratosUserId)
  if (user instanceof Error) return user

  // Fetch user's email from Kratos identity service
  const identity = await IdentityRepository().getIdentity(account.kratosUserId)
  if (identity instanceof Error) return identity

  /**
   * Create the upgrade request record in ERPNext
   *
   * This combines data from multiple sources:
   * - From MongoDB: username, phone (user.phone), current level
   * - From Kratos: email
   * - From mutation input: fullName, business details, bank details
   *
   * The record is created with status="Pending" for admin review
   */
  const requestResult = await ErpNext.createUpgradeRequest({
    currentLevel: account.level,
    requestedLevel: checkedLevel,
    username: (account.username as string) || account.id,
    fullName,
    phoneNumber: (user.phone as string) || "",
    email: identity.email as string | undefined,
    businessName,
    businessAddress,
    terminalRequested,
    bankName,
    bankBranch,
    accountType,
    currency,
    accountNumber,
    idDocument,
  })

  if (requestResult instanceof Error) return requestResult

  /**
   * Auto-upgrade logic for Level 2 (Pro)
   *
   * Level 2 requests are considered lower risk and are auto-approved.
   * The ERPNext record still exists for audit purposes, but the account
   * is upgraded immediately without waiting for manual approval.
   *
   * Level 3 (Merchant) requires manual admin approval in ERPNext before
   * the account level is updated.
   */
  if (checkedLevel === 2) {
    const upgradeResult = await updateAccountLevel({
      id: accountId,
      level: checkedLevel,
    })
    if (upgradeResult instanceof Error) return upgradeResult
  }

  return true
}

/**
 * Check if user has a pending upgrade request in ERPNext
 *
 * This is used to prevent users from submitting multiple upgrade requests.
 * Queries the "Account Upgrade Request" doctype in ERPNext for records
 * with status="Pending" matching the given username.
 *
 * @param username - The Flash username to check
 * @returns Object with hasPending flag and the requested level (if any)
 */
export const hasPendingUpgradeRequest = async (
  username: Username,
): Promise<{ hasPending: boolean; requestedLevel: AccountLevel | null } | ApplicationError> => {
  // Query ERPNext for pending requests
  const pendingRequest = await ErpNext.getPendingUpgradeRequest(username as string)

  if (pendingRequest instanceof Error) return pendingRequest

  // No pending request found - user can submit a new one
  if (pendingRequest === null) {
    return {
      hasPending: false,
      requestedLevel: null,
    }
  }

  // User has a pending request - return the requested level
  return {
    hasPending: true,
    requestedLevel: pendingRequest.requestedLevel as AccountLevel,
  }
}
