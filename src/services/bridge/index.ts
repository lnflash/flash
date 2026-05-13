/**
 * Bridge Service Layer
 * Orchestrates Bridge API client, repository, and implements business logic
 * for USD on/off-ramp functionality via Bridge.xyz
 */

import { BridgeConfig } from "@config"
import BridgeClient, {
  KycLink,
  VirtualAccount,
  ExternalAccountLinkUrl,
  Transfer,
} from "./client"
import * as BridgeAccountsRepo from "@services/mongoose/bridge-accounts"
import { AccountsRepository } from "@services/mongoose/accounts"
import { wrapAsyncFunctionsToRunInSpan } from "@services/tracing"
import { baseLogger } from "@services/logger"
import {
  BridgeDisabledError,
  BridgeAccountLevelError,
  BridgeKycPendingError,
  BridgeKycRejectedError,
  BridgeCustomerNotFoundError,
} from "./errors"
import { RepositoryError } from "@domain/errors"
import { toBridgeCustomerId, toBridgeExternalAccountId } from "@domain/primitives/bridge"

// ============ Types ============

type InitiateKycResult = {
  kycLink: string
  tosLink: string
}

type CreateVirtualAccountResult = {
  virtualAccountId: string
  bankName: string
  routingNumber: string
  accountNumberLast4: string
}

type AddExternalAccountResult = {
  linkUrl: string
  expiresAt: string
}

type InitiateWithdrawalResult = {
  transferId: string
  amount: string
  currency: string
  state: string
}

type WithdrawalResult = {
  transferId: string
  amount: string
  currency: string
  state: string
  createdAt: string
}

type KycStatusResult = "pending" | "approved" | "rejected" | null

type VirtualAccountResult = {
  bridgeVirtualAccountId: string
  bankName: string
  routingNumber: string
  accountNumberLast4: string
} | null

type ExternalAccountResult = {
  bridgeExternalAccountId: string
  bankName: string
  accountNumberLast4: string
  status: "pending" | "verified" | "failed"
}

// ============ Guards ============

const checkBridgeEnabled = (): true | BridgeDisabledError => {
  if (!BridgeConfig.enabled) {
    return new BridgeDisabledError()
  }
  return true
}

const checkAccountLevel = async (
  accountId: AccountId,
): Promise<Account | BridgeAccountLevelError | RepositoryError> => {
  const account = await AccountsRepository().findById(accountId)
  if (account instanceof Error) return account
  if (account.level < 2) {
    return new BridgeAccountLevelError()
  }
  return account
}

// ============ Service Methods ============

/**
 * Initiates KYC process for an account
 * - Creates Bridge customer if not exists
 * - Returns KYC and TOS links
 */
const initiateKyc = async (accountId: AccountId): Promise<InitiateKycResult | Error> => {
  baseLogger.info({ accountId, operation: "initiateKyc" }, "Bridge operation started")

  const enabledCheck = checkBridgeEnabled()
  if (enabledCheck instanceof Error) return enabledCheck

  const account = await checkAccountLevel(accountId)
  if (account instanceof Error) return account

  try {
    let customerId = account.bridgeCustomerId

    // Create customer if not exists
    if (!customerId) {
      // For now, create with minimal data - in production, gather from account profile
      const customer = await BridgeClient.createCustomer({
        type: "individual",
        first_name: account.username || "Flash",
        last_name: "User",
        email: `${account.id}@flash.app`, // Placeholder - should use real email
      })

      customerId = toBridgeCustomerId(customer.id)

      // Store customer ID
      const updateResult = await AccountsRepository().updateBridgeFields(accountId, {
        bridgeCustomerId: customerId,
        bridgeKycStatus: "pending",
      })
      if (updateResult instanceof Error) return updateResult
    }

    // Create KYC link
    const kycLink = await BridgeClient.createKycLink(customerId)

    const result: InitiateKycResult = {
      kycLink: kycLink.kyc_link,
      tosLink: kycLink.tos_link,
    }

    baseLogger.info(
      { accountId, operation: "initiateKyc", customerId },
      "Bridge operation completed",
    )

    return result
  } catch (error) {
    baseLogger.error(
      { accountId, operation: "initiateKyc", error },
      "Bridge operation failed",
    )
    return error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * Creates a virtual account for receiving USD deposits
 * - Requires approved KYC
 * - Creates IBEX Tron USDT receive address
 * - Creates Bridge virtual account pointing to Tron address
 */
const createVirtualAccount = async (
  accountId: AccountId,
): Promise<CreateVirtualAccountResult | Error> => {
  baseLogger.info(
    { accountId, operation: "createVirtualAccount" },
    "Bridge operation started",
  )

  const enabledCheck = checkBridgeEnabled()
  if (enabledCheck instanceof Error) return enabledCheck

  const account = await checkAccountLevel(accountId)
  if (account instanceof Error) return account

  try {
    const customerId = account.bridgeCustomerId
    if (!customerId) {
      return new BridgeCustomerNotFoundError(
        "Account has no Bridge customer ID. Complete KYC first.",
      )
    }

    // Check KYC status
    if (account.bridgeKycStatus === "pending") {
      return new BridgeKycPendingError()
    }
    if (account.bridgeKycStatus === "rejected") {
      return new BridgeKycRejectedError()
    }
    if (account.bridgeKycStatus !== "approved") {
      return new BridgeKycPendingError("KYC not yet completed")
    }

    // Get or create Tron address
    let tronAddress = account.bridgeTronAddress

    if (!tronAddress) {
      // TODO: Integrate with IBEX to create Tron USDT receive address
      // For now, this is a placeholder - actual implementation requires:
      // 1. Call Ibex.getCryptoReceiveOptions() to get Tron USDT option
      // 2. Call Ibex.createCryptoReceiveInfo() to get Tron address
      // This will be implemented when IBEX crypto receive methods are available
      return new Error("IBEX Tron address creation not yet implemented")
    }

    // Create Bridge virtual account
    const virtualAccount = await BridgeClient.createVirtualAccount(customerId, {
      source: { currency: "usd" },
      destination: {
        currency: "usdt",
        payment_rail: "tron",
        address: tronAddress,
      },
    })

    // Store virtual account in repository
    const repoResult = await BridgeAccountsRepo.createVirtualAccount({
      accountId: accountId as string,
      bridgeVirtualAccountId: virtualAccount.id,
      bankName: virtualAccount.source_deposit_instructions.bank_name || "",
      routingNumber: virtualAccount.source_deposit_instructions.bank_routing_number || "",
      accountNumberLast4:
        virtualAccount.source_deposit_instructions.bank_account_number?.slice(-4) || "",
    })
    if (repoResult instanceof Error) return repoResult

    const result: CreateVirtualAccountResult = {
      virtualAccountId: virtualAccount.id,
      bankName: virtualAccount.source_deposit_instructions.bank_name || "",
      routingNumber: virtualAccount.source_deposit_instructions.bank_routing_number || "",
      accountNumberLast4:
        virtualAccount.source_deposit_instructions.bank_account_number?.slice(-4) || "",
    }

    baseLogger.info(
      {
        accountId,
        operation: "createVirtualAccount",
        virtualAccountId: virtualAccount.id,
      },
      "Bridge operation completed",
    )

    return result
  } catch (error) {
    baseLogger.error(
      { accountId, operation: "createVirtualAccount", error },
      "Bridge operation failed",
    )
    return error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * Returns Bridge hosted bank linking URL for adding external accounts
 */
const addExternalAccount = async (
  accountId: AccountId,
): Promise<AddExternalAccountResult | Error> => {
  baseLogger.info(
    { accountId, operation: "addExternalAccount" },
    "Bridge operation started",
  )

  const enabledCheck = checkBridgeEnabled()
  if (enabledCheck instanceof Error) return enabledCheck

  const account = await checkAccountLevel(accountId)
  if (account instanceof Error) return account

  try {
    const customerId = account.bridgeCustomerId
    if (!customerId) {
      return new BridgeCustomerNotFoundError(
        "Account has no Bridge customer ID. Complete KYC first.",
      )
    }

    const linkUrl = await BridgeClient.getExternalAccountLinkUrl(customerId)

    const result: AddExternalAccountResult = {
      linkUrl: linkUrl.link_url,
      expiresAt: linkUrl.expires_at,
    }

    baseLogger.info(
      { accountId, operation: "addExternalAccount" },
      "Bridge operation completed",
    )

    return result
  } catch (error) {
    baseLogger.error(
      { accountId, operation: "addExternalAccount", error },
      "Bridge operation failed",
    )
    return error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * Initiates a withdrawal from USDT to USD bank account
 * - Orchestrates IBEX → Bridge transfer
 */
const initiateWithdrawal = async (
  accountId: AccountId,
  amount: string,
  externalAccountId: string,
): Promise<InitiateWithdrawalResult | Error> => {
  baseLogger.info(
    { accountId, amount, externalAccountId, operation: "initiateWithdrawal" },
    "Bridge operation started",
  )

  const enabledCheck = checkBridgeEnabled()
  if (enabledCheck instanceof Error) return enabledCheck

  const account = await checkAccountLevel(accountId)
  if (account instanceof Error) return account

  try {
    const customerId = account.bridgeCustomerId
    if (!customerId) {
      return new BridgeCustomerNotFoundError(
        "Account has no Bridge customer ID. Complete KYC first.",
      )
    }

    const tronAddress = account.bridgeTronAddress
    if (!tronAddress) {
      return new Error("Account has no Tron address. Create virtual account first.")
    }

    // Verify external account exists
    const externalAccounts = await BridgeAccountsRepo.findExternalAccountsByAccountId(
      accountId as string,
    )
    if (externalAccounts instanceof Error) return externalAccounts

    const targetAccount = externalAccounts.find(
      (acc) => acc.bridgeExternalAccountId === externalAccountId,
    )
    if (!targetAccount) {
      return new Error("External account not found")
    }
    if (targetAccount.status !== "verified") {
      return new Error("External account is not verified")
    }

    // Create transfer via Bridge
    const transfer = await BridgeClient.createTransfer(customerId, {
      amount,
      on_behalf_of: customerId,
      source: {
        payment_rail: "tron",
        currency: "usdt",
        from_address: tronAddress,
      },
      destination: {
        payment_rail: "ach",
        currency: "usd",
        external_account_id: externalAccountId,
      },
    })

    // Store withdrawal record
    const withdrawalResult = await BridgeAccountsRepo.createWithdrawal({
      accountId: accountId as string,
      bridgeTransferId: transfer.id,
      amount: transfer.amount,
      currency: transfer.currency,
      externalAccountId,
      status: "pending",
    })
    if (withdrawalResult instanceof Error) return withdrawalResult

    const result: InitiateWithdrawalResult = {
      transferId: transfer.id,
      amount: transfer.amount,
      currency: transfer.currency,
      state: transfer.state,
    }

    baseLogger.info(
      { accountId, operation: "initiateWithdrawal", transferId: transfer.id },
      "Bridge operation completed",
    )

    return result
  } catch (error) {
    baseLogger.error(
      { accountId, operation: "initiateWithdrawal", error },
      "Bridge operation failed",
    )
    return error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * Returns KYC status for an account
 */
const getKycStatus = async (accountId: AccountId): Promise<KycStatusResult | Error> => {
  baseLogger.info({ accountId, operation: "getKycStatus" }, "Bridge operation started")

  const enabledCheck = checkBridgeEnabled()
  if (enabledCheck instanceof Error) return enabledCheck

  const account = await checkAccountLevel(accountId)
  if (account instanceof Error) return account

  const result = account.bridgeKycStatus || null

  baseLogger.info(
    { accountId, operation: "getKycStatus", status: result },
    "Bridge operation completed",
  )

  return result
}

/**
 * Returns virtual account details for an account
 */
const getVirtualAccount = async (
  accountId: AccountId,
): Promise<VirtualAccountResult | Error> => {
  baseLogger.info(
    { accountId, operation: "getVirtualAccount" },
    "Bridge operation started",
  )

  const enabledCheck = checkBridgeEnabled()
  if (enabledCheck instanceof Error) return enabledCheck

  const account = await checkAccountLevel(accountId)
  if (account instanceof Error) return account

  try {
    const virtualAccount = await BridgeAccountsRepo.findVirtualAccountByAccountId(
      accountId as string,
    )

    // Repository returns RepositoryError if not found
    if (virtualAccount instanceof RepositoryError) {
      baseLogger.info(
        { accountId, operation: "getVirtualAccount", result: null },
        "Bridge operation completed - no virtual account",
      )
      return null
    }

    const result: VirtualAccountResult = {
      bridgeVirtualAccountId: virtualAccount.bridgeVirtualAccountId,
      bankName: virtualAccount.bankName,
      routingNumber: virtualAccount.routingNumber,
      accountNumberLast4: virtualAccount.accountNumberLast4,
    }

    baseLogger.info(
      {
        accountId,
        operation: "getVirtualAccount",
        virtualAccountId: result.bridgeVirtualAccountId,
      },
      "Bridge operation completed",
    )

    return result
  } catch (error) {
    baseLogger.error(
      { accountId, operation: "getVirtualAccount", error },
      "Bridge operation failed",
    )
    return error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * Returns list of linked external bank accounts
 */
const getExternalAccounts = async (
  accountId: AccountId,
): Promise<ExternalAccountResult[] | Error> => {
  baseLogger.info(
    { accountId, operation: "getExternalAccounts" },
    "Bridge operation started",
  )

  const enabledCheck = checkBridgeEnabled()
  if (enabledCheck instanceof Error) return enabledCheck

  const account = await checkAccountLevel(accountId)
  if (account instanceof Error) return account

  try {
    const externalAccounts = await BridgeAccountsRepo.findExternalAccountsByAccountId(
      accountId as string,
    )
    if (externalAccounts instanceof Error) return externalAccounts

    const result: ExternalAccountResult[] = externalAccounts.map((acc) => ({
      bridgeExternalAccountId: acc.bridgeExternalAccountId,
      bankName: acc.bankName,
      accountNumberLast4: acc.accountNumberLast4,
      status: acc.status as "pending" | "verified" | "failed",
    }))

    baseLogger.info(
      { accountId, operation: "getExternalAccounts", count: result.length },
      "Bridge operation completed",
    )

    return result
  } catch (error) {
    baseLogger.error(
      { accountId, operation: "getExternalAccounts", error },
      "Bridge operation failed",
    )
    return error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * Returns list of withdrawals
 */
const getWithdrawals = async (
  accountId: AccountId,
): Promise<WithdrawalResult[] | Error> => {
  baseLogger.info({ accountId, operation: "getWithdrawals" }, "Bridge operation started")

  const enabledCheck = checkBridgeEnabled()
  if (enabledCheck instanceof Error) return enabledCheck

  const account = await checkAccountLevel(accountId)
  if (account instanceof Error) return account

  try {
    const withdrawals = await BridgeAccountsRepo.findWithdrawalsByAccountId(
      accountId as string,
    )
    if (withdrawals instanceof Error) return withdrawals

    const result: WithdrawalResult[] = withdrawals.map((w) => ({
      transferId: w.bridgeTransferId,
      amount: w.amount,
      currency: w.currency,
      state: w.status,
      createdAt: w.createdAt.toISOString(),
    }))

    baseLogger.info(
      { accountId, operation: "getWithdrawals", count: result.length },
      "Bridge operation completed",
    )

    return result
  } catch (error) {
    baseLogger.error(
      { accountId, operation: "getWithdrawals", error },
      "Bridge operation failed",
    )
    return error instanceof Error ? error : new Error(String(error))
  }
}

// ============ Export with Tracing ============

export default wrapAsyncFunctionsToRunInSpan({
  namespace: "services.bridge",
  fns: {
    initiateKyc,
    createVirtualAccount,
    addExternalAccount,
    initiateWithdrawal,
    getKycStatus,
    getVirtualAccount,
    getExternalAccounts,
    getWithdrawals,
  },
})
