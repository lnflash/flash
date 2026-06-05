/**
 * Bridge Sandbox E2E — Helpers
 *
 * Shared utilities for sandbox end-to-end tests.
 * Follows the test/galoy/helpers pattern: executes GraphQL operations
 * via the schema (graphql() from the graphql library), not via
 * direct resolver calls.
 *
 * All GraphQL return shapes verified against source code.
 */

import { graphql, Source } from "graphql"

import { UsersRepository } from "@services/mongoose"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import { Account as AccountModel } from "@services/mongoose/schema"
import { AccountsRepository as AccountsRepo } from "@services/mongoose/accounts"
import { createAccountWithPhoneIdentifier } from "@app/accounts"
import { addWalletIfNonexistent } from "@app/accounts/add-wallet"
import { getDefaultAccountsConfig } from "@config"
import { CouldNotFindAccountFromKratosIdError, RepositoryError } from "@domain/errors"
import { AccountLevel } from "@domain/accounts"
import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"
import { randomPhone, randomUserId } from "test/galoy/helpers"

import { gqlMainSchema } from "@graphql/public"
import { kycHandler } from "@services/bridge/webhook-server/routes/kyc"
import { externalAccountHandler } from "@services/bridge/webhook-server/routes/external-account"
import { depositHandler } from "@services/bridge/webhook-server/routes/deposit"
import { BridgeDeposits } from "@services/mongoose/schema"
import { createReqRes } from "./helpers/http-utils"

// ============ Types ============

export interface BridgeTestUser {
  accountId: string
  walletId: string
  customerId?: string
  virtualAccountId?: string
  level: AccountLevel
}

// ============ Schema Execution ============

function buildContext(accountId: string): GraphQLPublicContextAuth {
  return {
    domainAccount: { id: accountId, level: 1 },
  } as GraphQLPublicContextAuth
}

export async function execQuery(
  source: string,
  accountId: string,
  variableValues?: Record<string, any>,
): Promise<any> {
  const result = await graphql({
    schema: gqlMainSchema,
    source: new Source(source),
    contextValue: buildContext(accountId),
    variableValues,
  })
  if (result.errors) {
    return { errors: result.errors.map((e: any) => ({ message: e.message })) }
  }
  return result.data
}

// ============ User Creation ============

/**
 * Create a test user with the given account level and USDT wallet.
 * Persists to local MongoDB (not Bridge sandbox).
 */
export async function createBridgeSandboxUser(
  level: AccountLevel = AccountLevel.One,
): Promise<BridgeTestUser> {
  const phone = randomPhone()
  const kratosUserId = randomUserId()

  // Create Kratos user
  const user = await UsersRepository().update({
    id: kratosUserId,
    deviceTokens: [`token-${kratosUserId}`] as DeviceToken[],
    phone,
  })
  if (user instanceof Error) throw user

  // Create account
  let account = await AccountsRepository().findByUserId(kratosUserId)

  if (account instanceof CouldNotFindAccountFromKratosIdError) {
    account = await createAccountWithPhoneIdentifier({
      newAccountInfo: { phone, kratosUserId },
      config: {
        ...getDefaultAccountsConfig(),
        initialLevel: level,
      },
    })
    if (account instanceof Error) throw account

    // Add USDT wallet for Bridge flows
    const usdtWallet = await addWalletIfNonexistent({
      currency: WalletCurrency.Usdt,
      accountId: account.id,
      type: WalletType.Checking,
    })
    if (usdtWallet instanceof Error) throw usdtWallet

    // Set account level directly (createAccountWithPhoneIdentifier may not enforce initialLevel)
    await AccountModel.updateOne(
      { _id: account.id },
      { $set: { level } },
    )
  }

  if (account instanceof Error) throw account

  // Get the USDT wallet
  const walletsResult = await WalletsRepository().listByAccountId(account.id)
  if (walletsResult instanceof RepositoryError) throw walletsResult
  const usdtWallet = walletsResult.find(
    (w: any) => w.currency === WalletCurrency.Usdt && w.type === WalletType.Checking,
  )
  if (!usdtWallet) throw new Error("No USDT wallet created for sandbox user")

  return {
    accountId: account.id,
    walletId: usdtWallet.id,
    level,
  }
}

// ============ Bridge Mutation Wrappers ============

const BRIDGE_INITIATE_KYC = `
  mutation BridgeInitiateKyc($input: BridgeInitiateKycInput!) {
    bridgeInitiateKyc(input: $input) {
      errors { message }
      kycLink { kycLink tosLink }
    }
  }
`

const BRIDGE_CREATE_VIRTUAL_ACCOUNT = `
  mutation BridgeCreateVirtualAccount {
    bridgeCreateVirtualAccount {
      errors { message }
      virtualAccount { id bankName routingNumber accountNumber accountNumberLast4 pending message kycLink tosLink }
    }
  }
`

const BRIDGE_ADD_EXTERNAL_ACCOUNT = `
  mutation BridgeAddExternalAccount {
    bridgeAddExternalAccount {
      errors { message }
      externalAccount { linkUrl expiresAt }
    }
  }
`

const BRIDGE_INITIATE_WITHDRAWAL = `
  mutation BridgeInitiateWithdrawal($input: BridgeInitiateWithdrawalInput!) {
    bridgeInitiateWithdrawal(input: $input) {
      errors { message }
      withdrawal { id amount currency status failureReason createdAt }
    }
  }
`

/**
 * Initiate Bridge KYC for a user.
 * Returns { errors, kycLink: { kycLink, tosLink } | null }
 */
export async function initiateKyc(
  accountId: string,
  email: string,
): Promise<{
  errors: Array<{ message: string }>
  kycLink?: { kycLink: string; tosLink: string }
}> {
  const data = await execQuery(BRIDGE_INITIATE_KYC, accountId, {
    input: { email },
  })
  return data?.bridgeInitiateKyc ?? { errors: [{ message: "No data returned" }] }
}

/**
 * Create a virtual account for a user.
 * Requires KYC to be completed first.
 */
export async function createVirtualAccount(
  accountId: string,
): Promise<{
  errors: Array<{ message: string }>
  virtualAccount?: Record<string, any>
}> {
  const data = await execQuery(BRIDGE_CREATE_VIRTUAL_ACCOUNT, accountId)
  return data?.bridgeCreateVirtualAccount ?? { errors: [{ message: "No data returned" }] }
}

/**
 * Add an external account (Plaid).
 * Requires KYC + virtual account to be completed first.
 */
export async function addExternalAccount(
  accountId: string,
): Promise<{
  errors: Array<{ message: string }>
  externalAccount?: { linkUrl: string; expiresAt: string }
}> {
  const data = await execQuery(BRIDGE_ADD_EXTERNAL_ACCOUNT, accountId)
  return data?.bridgeAddExternalAccount ?? { errors: [{ message: "No data returned" }] }
}

/**
 * Initiate a withdrawal.
 */
export async function initiateWithdrawal(
  accountId: string,
  input: { amount: string; externalAccountId: string },
): Promise<{
  errors: Array<{ message: string }>
  withdrawal?: Record<string, any>
}> {
  const data = await execQuery(BRIDGE_INITIATE_WITHDRAWAL, accountId, {
    input,
  })
  return data?.bridgeInitiateWithdrawal ?? { errors: [{ message: "No data returned" }] }
}

// ============ Webhook Injection ============

/**
 * Inject a KYC webhook payload directly into the Express route handler.
 * Tests the same handler code that runs in production.
 */
export async function injectKycWebhook(payload: {
  event_id: string
  event_object: { customer_id: string; kyc_status: string }
}): Promise<{ status: number; body?: any }> {
  const { req, res } = createReqRes({ body: payload })
  await kycHandler(req as any, res as any)
  return { status: res.statusCode, body: res._body }
}

/**
 * Inject an external account webhook payload directly into the Express route handler.
 * Simulates Bridge sending an external_account.created event after Plaid linking.
 */
export async function injectExternalAccountWebhook(payload: {
  event_id: string
  event_object: {
    id: string
    customer_id: string
    bank_name?: string
    last_4?: string
    active?: boolean
  }
}): Promise<{ status: number; body?: any }> {
  const { req, res } = createReqRes({ body: payload })
  await externalAccountHandler(req as any, res as any)
  return { status: res.statusCode, body: res._body }
}

/**
 * Inject a deposit webhook payload directly into the Express route handler.
 * Simulates Bridge sending a transfer state-transition event.
 */
export async function injectDepositWebhook(payload: {
  event_id: string
  event_object: {
    id: string
    state: string
    amount: string
    currency: string
    on_behalf_of: string
    receipt?: {
      initial_amount?: string
      subtotal_amount?: string
      final_amount?: string
      developer_fee?: string
      destination_tx_hash?: string
    }
  }
}): Promise<{ status: number; body?: any }> {
  const { req, res } = createReqRes({ body: payload })
  await depositHandler(req as any, res as any)
  return { status: res.statusCode, body: res._body }
}

// ============ ERPNext Verification ============

/**
 * Query ERPNext for a matching audit row.
 * Silently returns null when ERPNEXT_URL is not set.
 */
export async function verifyErpnextAuditRow(
  docType: string,
  referenceId: string,
): Promise<Record<string, unknown> | null> {
  if (!process.env.ERPNEXT_URL) {
    return null
  }
  try {
    const response = await fetch(
      `${process.env.ERPNEXT_URL}/api/resource/${docType}?filters=${JSON.stringify([["reference_id", "=", referenceId]])}`,
      {
        headers: {
          Authorization: `token ${process.env.ERPNEXT_API_KEY}:${process.env.ERPNEXT_API_SECRET}`,
        },
      },
    )
    if (!response.ok) return null
    const json = await response.json()
    return json.data?.[0] || null
  } catch {
    return null
  }
}

// ============ Deposit Log Lookup ============

/**
 * Find a deposit log by event ID directly from MongoDB.
 */
export async function findDepositLogByEventId(
  eventId: string,
): Promise<Record<string, any> | null> {
  const doc = await BridgeDeposits.findOne({ eventId }).lean().exec()
  return (doc as Record<string, any>) ?? null
}

// ============ Account Lookup ============

export async function getAccountById(accountId: string) {
  const account = await AccountsRepo().findById(accountId as AccountId)
  if (account instanceof Error) throw account
  return account
}
