/**
 * Bridge Service Layer
 * Orchestrates Bridge API client, repository, and implements business logic
 * for USD on/off-ramp functionality via Bridge.xyz
 */

import crypto from "crypto"

import { BridgeConfig } from "@config"

import * as BridgeAccountsRepo from "@services/mongoose/bridge-accounts"
import { AccountsRepository } from "@services/mongoose/accounts"
import { BridgeVirtualAccount } from "@services/mongoose/schema"
import { wrapAsyncFunctionsToRunInSpan } from "@services/tracing"
import { baseLogger } from "@services/logger"

import { RepositoryError } from "@domain/errors"
import { toBridgeCustomerId, toBridgeVirtualAccountId } from "@domain/primitives/bridge"
import { getBalanceForWallet } from "@app/wallets/get-balance-for-wallet"
import { sendBridgeWithdrawalNotificationBestEffort } from "@app/bridge/send-withdrawal-notification"
import { USDTAmount, WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"
import { WalletsRepository } from "@services/mongoose/wallets"

import { IdentityRepository } from "@services/kratos"
import IbexClient from "@services/ibex/client"

import {
  BridgeInsufficientFundsError,
  BridgeError,
  BridgeDisabledError,
  BridgeAccountLevelError,
  BridgeKycPendingError,
  BridgeKycRejectedError,
  BridgeKycOffboardedError,
  BridgeCustomerNotFoundError,
  BridgeWithdrawalNotFoundError,
  BridgeWithdrawalAlreadyInitiatedError,
} from "./errors"
import BridgeApiClient from "./client"

// ============ Types ============

type InitiateKycResult = {
  kycLink: string
  customerId: string
  tosLink: string
}

type CreateVirtualAccountResult = {
  virtualAccountId: string
  bankName: string
  routingNumber: string
  accountNumber: string
  accountNumberLast4: string
}

type AddExternalAccountResult = {
  linkUrl: string
  expiresAt: string
}

type WithdrawalRequestResult = {
  id: string
  amount: string
  currency: string
  externalAccountId: string
  status: string
  failureReason?: string
  createdAt: string
}

type InitiateWithdrawalResult = {
  id: string
  amount: string
  currency: string
  status: string
  bridgeTransferId?: string
  createdAt: string
}

type CancelWithdrawalResult = {
  id: string
  amount: string
  currency: string
  status: string
  createdAt: string
}

type WithdrawalResult = {
  id: string
  amount: string
  currency: string
  externalAccountId: string
  status: string
  bridgeTransferId?: string
  failureReason?: string
  createdAt: string
}

type KycStatusResult = "open" | "not_started" | "incomplete" | "awaiting_questionnaire" | "awaiting_ubo" | "under_review" | "paused" | "approved" | "rejected" | "offboarded" | null

type VirtualAccountResult = {
  bridgeVirtualAccountId: string
  bankName: string
  routingNumber: string
  accountNumber: string
  accountNumberLast4: string
} | null

type ExternalAccountResult = {
  bridgeExternalAccountId: string
  bankName: string
  accountNumberLast4: string
  status: "pending" | "verified" | "failed"
}

// ============ Helpers ============

export const deriveWithdrawalIdempotencyKey = (rowId: string): string =>
  crypto.createHash("sha256").update(`withdrawal:${rowId}`).digest("hex")

const ensureEthUsdtCashWallet = async (
  account: Account,
): Promise<Wallet | ApplicationError> => {
  const wallets = await WalletsRepository().listByAccountId(account.id)
  if (wallets instanceof Error) return wallets

  let usdtWallet = wallets.find(
    (wallet) =>
      wallet.currency === WalletCurrency.Usdt && wallet.type === WalletType.Checking,
  )

  if (!usdtWallet) {
    const createdWallet = await WalletsRepository().persistNew({
      accountId: account.id,
      type: WalletType.Checking,
      currency: WalletCurrency.Usdt,
    })
    if (createdWallet instanceof Error) return createdWallet
    usdtWallet = createdWallet
  }

  if (account.defaultWalletId !== usdtWallet.id) {
    const updatedAccount = await AccountsRepository().update({
      ...account,
      defaultWalletId: usdtWallet.id,
    })
    if (updatedAccount instanceof Error) return updatedAccount
  }

  return usdtWallet
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
const initiateKyc = async ({
  accountId,
  email,
  type,
  full_name,
}: {
  accountId: AccountId
  email: string
  type?: "individual" | "business"
  full_name: string
}): Promise<InitiateKycResult | Error> => {
  baseLogger.info({ accountId, operation: "initiateKyc" }, "Bridge operation started")

  const enabledCheck = checkBridgeEnabled()
  if (enabledCheck instanceof Error) return enabledCheck

  const account = await checkAccountLevel(accountId)
  if (account instanceof Error) return account

  if (account.bridgeKycStatus === "approved") {
    return new BridgeError("KYC already approved for this account")
  }

  const identity = await IdentityRepository().getIdentity(account.kratosUserId)

  if (identity instanceof Error) return identity

  const useremail = identity.email

  try {
    // Create KYC link
    const kycLink = await BridgeApiClient.createKycLink({
      email: useremail || email,
      type: type || "individual",
      full_name: full_name || account.username,
    })

    const result: InitiateKycResult = {
      kycLink: kycLink.kyc_link,
      customerId: kycLink.customer_id,
      tosLink: kycLink.tos_link,
    }

    // link the customer Id to the bridge account
    const customerId = toBridgeCustomerId(kycLink.customer_id)

    const updateResult = await AccountsRepository().updateBridgeFields(accountId, {
      bridgeCustomerId: customerId,
      bridgeKycStatus: "open",
    })

    if (updateResult instanceof Error) {
      return updateResult
    }

    baseLogger.info(
      { accountId, operation: "initiateKyc", kycLink },
      "Bridge operation completed",
    )

    return result
  } catch (error) {
    const bridgeError = error as { statusCode?: number; response?: { existing_kyc_link?: { kyc_link: string; customer_id: string; tos_link: string } } }

    if (bridgeError?.statusCode === 400 && bridgeError.response?.existing_kyc_link) {

      // store the customer id and the kyc status 
      const customerId = toBridgeCustomerId(bridgeError.response.existing_kyc_link.customer_id)
      await AccountsRepository().updateBridgeFields(accountId, {
        bridgeCustomerId: customerId,
        bridgeKycStatus: "not_started",
      })

      return {
        kycLink: bridgeError.response.existing_kyc_link.kyc_link,
        customerId: bridgeError.response.existing_kyc_link.customer_id,
        tosLink: bridgeError.response.existing_kyc_link.tos_link,
      }
    }

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
 * - Ensures an IBEX ETH-USDT Cash Wallet exists and is the account default
 * - Creates IBEX Ethereum USDT receive address
 * - Creates Bridge virtual account pointing to Ethereum address
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


  const PENDING_BRIDGE_STATUSES = new Set([
    "incomplete",
    "awaiting_questionnaire",
    "awaiting_ubo",
    "under_review",
    "paused",
  ])

  try {

    if (!account.bridgeCustomerId) {
      return new BridgeCustomerNotFoundError(
        "Account has no Bridge customer ID. Complete KYC first.",
      )
    }
    const customerId = toBridgeCustomerId(account.bridgeCustomerId)
    if (!customerId && !account.bridgeKycStatus) {
      return new BridgeCustomerNotFoundError(
        "Account has no Bridge customer ID. Complete KYC first.",
      )
    }

    const customer = await BridgeApiClient.getCustomer(customerId);

    if (customer instanceof Error) {
      baseLogger.error(
        { accountId, error: customer },
        "Failed to retrieve Bridge customer status"
      )
      return customer
    }

    const kycStatus = customer.status


    // Check KYC status
    if (kycStatus === "offboarded") {
      return new BridgeKycOffboardedError()
    }
    if (kycStatus === "rejected") {
      return new BridgeKycRejectedError()
    }
    if (PENDING_BRIDGE_STATUSES.has(kycStatus!) || kycStatus as string === "open") {
      return new BridgeKycPendingError()
    }
    if (kycStatus !== "active" && kycStatus as string !== "approved") {
      return new BridgeKycPendingError("KYC not yet completed")
    }

    // Idempotency guard first: do not mutate wallets/default when a VA already exists
    const existingVa = await BridgeAccountsRepo.findVirtualAccountByAccountId(
      accountId as string,
    )
    if (!(existingVa instanceof RepositoryError)) {
      return {
        virtualAccountId: existingVa.bridgeVirtualAccountId!,
        bankName: existingVa.bankName,
        routingNumber: existingVa.routingNumber,
        accountNumber: existingVa.accountNumber,
        accountNumberLast4: existingVa.accountNumberLast4,
      }
    }

    const usdtCashWallet = await ensureEthUsdtCashWallet(account)
    if (usdtCashWallet instanceof Error) return usdtCashWallet

    // Get or create Ethereum USDT receive address for the ETH-USDT Cash Wallet
    let ethereumAddress = account.bridgeEthereumAddress

    if (!ethereumAddress) {
      const option = await IbexClient.getEthereumUsdtOption()
      if (option instanceof Error) return new BridgeError(option.message)

      option.name = `USDT-ETH ${account.username}-${crypto.randomBytes(4).toString("hex")}`
      const receiveInfo = await IbexClient.createCryptoReceiveInfo(
        usdtCashWallet.id as IbexAccountId,
        option,
      )
      if (receiveInfo instanceof Error) return new BridgeError(receiveInfo.message)

      const updateResult = await AccountsRepository().updateBridgeFields(accountId, {
        bridgeEthereumAddress: receiveInfo.data.address,
      })
      if (updateResult instanceof Error) return updateResult

      ethereumAddress = receiveInfo.data.address
    }

    const vaIdempotencyKey = `${accountId}:${crypto.randomUUID()}`

    // Create Bridge virtual account
    const virtualAccount = await BridgeApiClient.createVirtualAccount(
      customerId,
      {
        source: { currency: "usd" },
        destination: {
          currency: "usdt",
          payment_rail: "ethereum",
          address: ethereumAddress,
        },
      },
      vaIdempotencyKey,
    )

    const fullAccountNumber =
      virtualAccount.source_deposit_instructions.bank_account_number || ""

    // Store virtual account in repository
    const repoResult = await BridgeAccountsRepo.createVirtualAccount({
      accountId: accountId as string,
      bridgeVirtualAccountId: virtualAccount.id,
      bankName: virtualAccount.source_deposit_instructions.bank_name || "",
      routingNumber: virtualAccount.source_deposit_instructions.bank_routing_number || "",
      accountNumber: fullAccountNumber,
      accountNumberLast4: fullAccountNumber.slice(-4),
    })
    if (repoResult instanceof Error) return repoResult

    const result: CreateVirtualAccountResult = {
      virtualAccountId: virtualAccount.id,
      bankName: virtualAccount.source_deposit_instructions.bank_name || "",
      routingNumber: virtualAccount.source_deposit_instructions.bank_routing_number || "",
      accountNumber: fullAccountNumber,
      accountNumberLast4: fullAccountNumber.slice(-4),
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

    const linkUrl = await BridgeApiClient.getExternalAccountLinkUrl(customerId)

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
 * Requests a withdrawal — validates everything and stores a pending record in MongoDB.
 * Does NOT call the Bridge API. Returns the pending withdrawal so the frontend can
 * display a confirmation screen before the user commits.
 */
const requestWithdrawal = async (
  accountId: AccountId,
  amount: string,
  externalAccountId: string,
): Promise<WithdrawalRequestResult | Error> => {
  baseLogger.info(
    { accountId, amount, externalAccountId, operation: "requestWithdrawal" },
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

    const ethereumAddress = account.bridgeEthereumAddress
    if (!ethereumAddress) {
      return new Error("Account has no Ethereum address. Create virtual account first.")
    }

    const wallets = await WalletsRepository().listByAccountId(accountId)
    if (wallets instanceof Error) return wallets
    const usdtWallet = wallets.find(
      (w) => w.currency === WalletCurrency.Usdt && w.type === WalletType.Checking,
    )
    if (!usdtWallet) {
      return new BridgeInsufficientFundsError("No USDT wallet found on account")
    }
    const balance = await getBalanceForWallet({
      walletId: usdtWallet.id,
      currency: WalletCurrency.Usdt,
    })
    if (balance instanceof Error) return balance

    if (!(balance instanceof USDTAmount)) {
      return new BridgeInsufficientFundsError("Invalid balance type")
    }
    const withdrawalAmount = parseFloat(amount)
    if (isNaN(withdrawalAmount) || withdrawalAmount <= 0) {
      return new BridgeInsufficientFundsError("Invalid withdrawal amount")
    }

    const availableBalance = balance.toIbex()
    if (availableBalance < withdrawalAmount) {
      baseLogger.warn(
        { accountId, availableBalance, withdrawalAmount, operation: "requestWithdrawal" },
        "Insufficient USDT balance for withdrawal",
      )
      return new BridgeInsufficientFundsError(
        `Insufficient USDT balance: available ${availableBalance}, requested ${withdrawalAmount}`,
      )
    }

    // CRIT-2 (ENG-281): Verify caller owns this external account
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

    const existingWithdrawal =
      await BridgeAccountsRepo.findPendingWithdrawalWithoutTransfer(
        accountId as string,
        externalAccountId,
        amount,
      )
    if (existingWithdrawal instanceof Error) return existingWithdrawal

    const pendingWithdrawal =
      existingWithdrawal ||
      (await BridgeAccountsRepo.createWithdrawal({
        accountId: accountId as string,
        amount,
        currency: "usdt",
        externalAccountId,
        status: "pending",
      }))
    if (pendingWithdrawal instanceof Error) return pendingWithdrawal

    baseLogger.info(
      { accountId, operation: "requestWithdrawal", withdrawalId: pendingWithdrawal.id },
      "Bridge operation completed",
    )

    return {
      id: pendingWithdrawal.id,
      amount: pendingWithdrawal.amount,
      currency: pendingWithdrawal.currency,
      externalAccountId: pendingWithdrawal.externalAccountId,
      status: pendingWithdrawal.status,
      failureReason: pendingWithdrawal.failureReason,
      createdAt: pendingWithdrawal.createdAt.toISOString(),
    }
  } catch (error) {
    baseLogger.error(
      { accountId, operation: "requestWithdrawal", error },
      "Bridge operation failed",
    )
    return error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * Initiates a previously requested withdrawal — fetches the pending record by ID,
 * re-checks balance, then submits the transfer to Bridge.
 */
const initiateWithdrawal = async (
  accountId: AccountId,
  withdrawalId: string,
): Promise<InitiateWithdrawalResult | Error> => {
  baseLogger.info(
    { accountId, withdrawalId, operation: "initiateWithdrawal" },
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

    const ethereumAddress = account.bridgeEthereumAddress
    if (!ethereumAddress) {
      return new Error("Account has no Ethereum address. Create virtual account first.")
    }

    const pendingWithdrawal = await BridgeAccountsRepo.findWithdrawalById(withdrawalId)
    if (pendingWithdrawal instanceof Error) {
      return new BridgeWithdrawalNotFoundError()
    }
    if (pendingWithdrawal.accountId !== (accountId as string)) {
      return new BridgeWithdrawalNotFoundError()
    }
    if (pendingWithdrawal.status !== "pending" || pendingWithdrawal.bridgeTransferId) {
      return new BridgeWithdrawalAlreadyInitiatedError()
    }

    const { amount, externalAccountId } = pendingWithdrawal

    // Re-check balance at execution time — funds may have changed since the request
    const wallets = await WalletsRepository().listByAccountId(accountId)
    if (wallets instanceof Error) return wallets
    const usdtWallet = wallets.find(
      (w) => w.currency === WalletCurrency.Usdt && w.type === WalletType.Checking,
    )
    if (!usdtWallet) {
      return new BridgeInsufficientFundsError("No USDT wallet found on account")
    }
    const balance = await getBalanceForWallet({
      walletId: usdtWallet.id,
      currency: WalletCurrency.Usdt,
    })
    if (balance instanceof Error) return balance
    if (!(balance instanceof USDTAmount)) {
      return new BridgeInsufficientFundsError("Invalid balance type")
    }
    const availableBalance = balance.toIbex()
    if (availableBalance < parseFloat(amount)) {
      return new BridgeInsufficientFundsError(
        `Insufficient USDT balance: available ${availableBalance}, requested ${amount}`,
      )
    }

    const idempotencyKey = deriveWithdrawalIdempotencyKey(pendingWithdrawal.id)

    const transfer = await BridgeApiClient.createTransfer(
      customerId,
      {
        amount,
        on_behalf_of: customerId,
        source: {
          payment_rail: "ethereum",
          currency: "usdt",
          from_address: ethereumAddress,
        },
        destination: {
          payment_rail: "ach",
          currency: "usd",
          external_account_id: externalAccountId,
        },
      },
      idempotencyKey,
    )

    const updated = await BridgeAccountsRepo.updateWithdrawalTransferId(
      pendingWithdrawal.id,
      transfer.id,
      transfer.amount,
      transfer.currency,
    )
    if (updated instanceof Error) return updated

    baseLogger.info(
      { accountId, operation: "initiateWithdrawal", transferId: transfer.id },
      "Bridge operation completed",
    )

    return {
      id: updated.id,
      amount: updated.amount,
      currency: updated.currency,
      status: updated.status,
      bridgeTransferId: updated.bridgeTransferId,
      createdAt: updated.createdAt.toISOString(),
    }
  } catch (error) {
    baseLogger.error(
      { accountId, operation: "initiateWithdrawal", error },
      "Bridge operation failed",
    )
    return error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * Cancels a pending withdrawal request before it has been submitted to Bridge.
 * Fails if the withdrawal already has a bridgeTransferId (transfer in-flight).
 */
const cancelWithdrawalRequest = async (
  accountId: AccountId,
  withdrawalId: string,
): Promise<CancelWithdrawalResult | Error> => {
  baseLogger.info(
    { accountId, withdrawalId, operation: "cancelWithdrawalRequest" },
    "Bridge operation started",
  )

  const enabledCheck = checkBridgeEnabled()
  if (enabledCheck instanceof Error) return enabledCheck

  const account = await checkAccountLevel(accountId)
  if (account instanceof Error) return account

  try {
    // Verify the withdrawal exists and belongs to this account before attempting cancel
    const withdrawal = await BridgeAccountsRepo.findWithdrawalById(withdrawalId)
    if (withdrawal instanceof Error) {
      return new BridgeWithdrawalNotFoundError()
    }
    if (withdrawal.accountId !== (accountId as string)) {
      return new BridgeWithdrawalNotFoundError()
    }
    if (withdrawal.bridgeTransferId) {
      return new BridgeWithdrawalAlreadyInitiatedError()
    }

    const cancelled = await BridgeAccountsRepo.cancelWithdrawal(
      accountId as string,
      withdrawalId,
    )
    if (cancelled instanceof Error) {
      return new BridgeWithdrawalNotFoundError()
    }

    baseLogger.info(
      { accountId, operation: "cancelWithdrawalRequest", withdrawalId },
      "Bridge operation completed",
    )

    await sendBridgeWithdrawalNotificationBestEffort({
      accountId: accountId as string,
      amount: cancelled.amount,
      currency: cancelled.currency,
      outcome: "cancelled",
    })

    return {
      id: cancelled.id,
      amount: cancelled.amount,
      currency: cancelled.currency,
      status: cancelled.status,
      createdAt: cancelled.createdAt.toISOString(),
    }
  } catch (error) {
    baseLogger.error(
      { accountId, operation: "cancelWithdrawalRequest", error },
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



  if (!account.bridgeCustomerId) {
    return null
  }

  const customerId = toBridgeCustomerId(account.bridgeCustomerId)

  // get the customer status from Bridge API to ensure we have the latest status (in case of updates via Bridge dashboard or webhook events)

  try {
    const customer = await BridgeApiClient.getCustomer(customerId)

    if (customer instanceof Error) return customer

    let kycStatus: KycStatusResult = null

    switch (customer.status) {
      case "active":
        kycStatus = "approved"
        break
      case "awaiting_questionnaire":
      case "not_started":
      case "incomplete":
      case "under_review":
      case "rejected":
      case "offboarded":
      case "paused":
      case "awaiting_ubo":
        kycStatus = customer.status
        break
      default:
        kycStatus = "open"
    }
    if (account.bridgeKycStatus !== kycStatus) {
      const updateResult = await AccountsRepository().updateBridgeFields(accountId, {
        bridgeKycStatus: kycStatus,
      })
      if (updateResult instanceof Error) return updateResult
    }


    // check if the customer is approved and don't have the virtual account yet, create the virtual account proactively so that the user doesn't have to wait for it when they try to make a deposit
    if (kycStatus === "approved") {

      // check if the user has active virtual account, if not create one proactively to avoid delay when user tries to make a deposit
      const bridgeVirtualAccounts = await BridgeApiClient.getVirtualAccountByCustomerId(customerId)

      if (bridgeVirtualAccounts instanceof Error) {
        baseLogger.error(
          { accountId, operation: "getKycStatus", error: bridgeVirtualAccounts },
          "Failed to retrieve virtual accounts for customer after KYC approval",
        )
      }

      const existingVa = await BridgeAccountsRepo.findVirtualAccountByAccountId(
        accountId as string,
      )

      const relatedVa = bridgeVirtualAccounts.find((va) => va.destination.address === account.bridgeEthereumAddress)

      if (relatedVa?.status === "activated") {

        // if there's a related VA on Bridge side but it's not in our repo, create it in our repo to keep them in sync
        if (existingVa instanceof RepositoryError) {
          const repoResult = await BridgeAccountsRepo.createVirtualAccount({
            accountId: accountId as string,
            bridgeVirtualAccountId: relatedVa.id,
            bankName: relatedVa.source_deposit_instructions.bank_name || "",
            routingNumber: relatedVa.source_deposit_instructions.bank_routing_number || "",
            accountNumber: relatedVa.source_deposit_instructions.bank_account_number || "",
            accountNumberLast4: relatedVa.source_deposit_instructions.bank_account_number?.slice(-4) || "",
          })
          if (repoResult instanceof Error) {
            baseLogger.error(
              { accountId, operation: "getKycStatus", error: repoResult },
              "Failed to create virtual account in repo after KYC approval",
            )
          } else {
            baseLogger.info(
              { accountId, operation: "getKycStatus", virtualAccountId: relatedVa.id },
              "Proactively updated virtual account in repo after KYC approval",
            )
          }
        }
      } else {

        const vaResult = await createVirtualAccount(accountId)
        if (vaResult instanceof Error) {
          baseLogger.error(
            { accountId, operation: "getKycStatus", error: vaResult },
            "Failed to create virtual account after KYC approval",
          )
        } else {
          baseLogger.info(
            { accountId, operation: "getKycStatus", virtualAccountId: vaResult.virtualAccountId },
            "Proactively created virtual account after KYC approval",
          )
        }
      }
    }

    baseLogger.info(
      { accountId, operation: "getKycStatus", kycStatus: kycStatus },
      "Bridge operation completed",
    )

    return kycStatus
  } catch (error) {
    baseLogger.error(
      { accountId, operation: "getKycStatus", error },
      "Bridge operation failed",
    )
    return error instanceof Error ? error : new Error(String(error))
  }


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

    // check if the virtual account still exists on Bridge side - if not, delete it from our repo and return null
    const bridgeVa = await BridgeApiClient.getVirtualAccount(account.bridgeCustomerId!, toBridgeVirtualAccountId(virtualAccount.bridgeVirtualAccountId!))

    if (bridgeVa instanceof Error) {
      return new BridgeError(`Failed to retrieve virtual account from Bridge: ${bridgeVa.message}`)
    }

    // check if the virtual account is still activated on Bridge side - if not, delete it from our repo and return null
    if (bridgeVa.status !== "activated") {

      // delete the virtual account from our repo since it's no longer valid

      await BridgeVirtualAccount.deleteOne({
        bridgeVirtualAccountId: virtualAccount.bridgeVirtualAccountId! as string
      })

      return null
    }


    const result: VirtualAccountResult = {
      bridgeVirtualAccountId: virtualAccount.bridgeVirtualAccountId!,
      bankName: virtualAccount.bankName,
      routingNumber: virtualAccount.routingNumber,
      accountNumber: virtualAccount.accountNumber,
      accountNumberLast4: virtualAccount.accountNumberLast4,
    }

    baseLogger.info(
      {
        accountId,
        operation: "getVirtualAccount",
        virtualAccountId: result!.bridgeVirtualAccountId,
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

    const result: WithdrawalResult[] = withdrawals
      .filter((w) => w.bridgeTransferId !== null && w.bridgeTransferId !== undefined)
      .map((w) => ({
        id: w.id,
        amount: w.amount,
        currency: w.currency,
        externalAccountId: w.externalAccountId,
        status: w.status,
        bridgeTransferId: w.bridgeTransferId,
        failureReason: w.failureReason,
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
    requestWithdrawal,
    initiateWithdrawal,
    cancelWithdrawalRequest,
    getKycStatus,
    getVirtualAccount,
    getExternalAccounts,
    getWithdrawals,
  },
})
