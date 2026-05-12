/**
 * Bridge Service Layer
 * Orchestrates Bridge API client, repository, and implements business logic
 * for USD on/off-ramp functionality via Bridge.xyz
 */

import crypto from "crypto"

import { BridgeConfig } from "@config"

import * as BridgeAccountsRepo from "@services/mongoose/bridge-accounts"
import { AccountsRepository } from "@services/mongoose/accounts"
import { wrapAsyncFunctionsToRunInSpan } from "@services/tracing"
import { baseLogger } from "@services/logger"

import { RepositoryError } from "@domain/errors"
import { toBridgeCustomerId } from "@domain/primitives/bridge"
import { getBalanceForWallet } from "@app/wallets/get-balance-for-wallet"
import { USDTAmount, WalletCurrency } from "@domain/shared"
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
  BridgeCustomerNotFoundError,
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
      bridgeKycStatus: "pending",
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

      const receiveInfo = await IbexClient.createCryptoReceiveInfo(
        usdtCashWallet.id as IbexAccountId,
        option,
      )
      if (receiveInfo instanceof Error) return new BridgeError(receiveInfo.message)

      const updateResult = await AccountsRepository().updateBridgeFields(accountId, {
        bridgeEthereumAddress: receiveInfo.address,
      })
      if (updateResult instanceof Error) return updateResult

      ethereumAddress = receiveInfo.address
    }

    // Deterministic key so Bridge deduplicates on their side if two calls race past
    // the check above before either has written to the repo.
    const vaIdempotencyKey = crypto
      .createHash("sha256")
      .update(`va:${accountId}`)
      .digest("hex")

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
        {
          accountId,
          availableBalance,
          withdrawalAmount,
          operation: "initiateWithdrawal",
        },
        "Insufficient USDT balance for withdrawal",
      )
      return new BridgeInsufficientFundsError(
        `Insufficient USDT balance: available ${availableBalance}, requested ${withdrawalAmount}`,
      )
    }

    // CRIT-2 (ENG-281): Verify caller owns this external account (ownership enforced here
    // and at DB level via compound index — see schema.ts BridgeExternalAccountSchema)
    const externalAccounts = await BridgeAccountsRepo.findExternalAccountsByAccountId(
      accountId as string,
    )
    if (externalAccounts instanceof Error) return externalAccounts

    const targetAccount = externalAccounts.find(
      (acc) => acc.bridgeExternalAccountId === externalAccountId,
    )
    if (!targetAccount) {
      // Do not leak existence — return same error regardless of whether account exists
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

    // Store withdrawal record, or reuse the in-flight row for a retry of the same request.
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

    const idempotencyKey = deriveWithdrawalIdempotencyKey(pendingWithdrawal.id)

    // Create transfer via Bridge
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

    const result: InitiateWithdrawalResult = {
      transferId: transfer.id,
      amount: transfer.amount,
      currency: transfer.currency,
      state: transfer.state,
    }

    const withdrawalResult = await BridgeAccountsRepo.updateWithdrawalTransferId(
      pendingWithdrawal.id,
      transfer.id,
      transfer.amount,
      transfer.currency,
    )

    if (withdrawalResult instanceof Error) return withdrawalResult

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
      .filter((w) => w.bridgeTransferId !== null || w.bridgeTransferId !== undefined)
      .map((w) => ({
        transferId: w.bridgeTransferId!,
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
