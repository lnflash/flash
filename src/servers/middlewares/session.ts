import DataLoader from "dataloader"

import { Accounts, Transactions } from "@app"
import { DEFAULT_CASH_WALLET_CLIENT_CAPABILITIES } from "@app/cash-wallet-cutover"
import { recordExceptionInCurrentSpan } from "@services/tracing"
import jsonwebtoken from "jsonwebtoken"

import { getDefaultAccountsConfig } from "@config"

import { mapError } from "@graphql/error-map"

import { createAccountWithPhoneIdentifier } from "@app/accounts"
import { maybeExtendSession } from "@app/authentication"
import { checkedToUserId } from "@domain/accounts"
import { CouldNotFindAccountFromKratosIdError } from "@domain/errors"
import { ErrorLevel, ValidationError } from "@domain/shared"
import { IdentityRepository } from "@services/kratos"
import { baseLogger } from "@services/logger"
import { UsersRepository } from "@services/mongoose"
import { IbexError } from "@services/ibex/errors"

// The Kratos after-registration web_hook runs with `response.parse: false`:
// the identity is committed whether or not the api managed to write its
// account. A failed write (duplicate key, wallet provider down) therefore
// leaves a logged-in identity with no account, and every request it makes
// lands here. Re-run the registration write from the identity's own phone
// trait. If that is not possible the original not-found error stands and the
// caller answers it as "not authenticated" — it must never crash on it.
const repairOrphanedIdentity = async ({
  userId,
  orphanError,
  logger,
}: {
  userId: UserId
  orphanError: CouldNotFindAccountFromKratosIdError
  logger: typeof baseLogger
}): Promise<Account | RepositoryError> => {
  const identity = await IdentityRepository().getIdentity(userId)
  if (identity instanceof Error) {
    logger.error(
      { err: identity, kratosUserId: userId },
      "orphaned kratos identity: could not load identity",
    )
    return orphanError
  }

  if (!identity.phone) {
    logger.error(
      { kratosUserId: userId },
      "orphaned kratos identity: no phone trait to repair from",
    )
    return orphanError
  }

  const account = await createAccountWithPhoneIdentifier({
    newAccountInfo: { kratosUserId: userId, phone: identity.phone },
    config: getDefaultAccountsConfig(),
  })
  if (account instanceof Error) {
    recordExceptionInCurrentSpan({
      error: account,
      level: ErrorLevel.Critical,
      attributes: { kratosUserId: userId },
    })
    logger.error(
      { err: account, kratosUserId: userId },
      "orphaned kratos identity: repair failed",
    )
    return orphanError
  }

  logger.warn(
    { kratosUserId: userId, accountId: account.id },
    "orphaned kratos identity repaired",
  )
  return account
}

export const sessionPublicContext = async ({
  tokenPayload,
  ip,
}: {
  tokenPayload: jsonwebtoken.JwtPayload
  ip: IpAddress | undefined
}): Promise<GraphQLPublicContext> => {
  const logger = baseLogger.child({ tokenPayload })

  let domainAccount: Account | undefined
  let user: User | undefined

  const sessionId = tokenPayload?.session_id
  const expiresAt = tokenPayload?.expires_at

  // Space-delimited OAuth-style claim minted for API-key sessions (FIP-07)
  const scopes =
    typeof tokenPayload?.scope === "string" ? tokenPayload.scope.split(" ") : undefined

  // note: value should match (ie: "anon") if not an accountId
  // settings from dev/ory/oathkeeper.yml/authenticator/anonymous/config/subjet
  const maybeUserId = checkedToUserId(tokenPayload?.sub ?? "")

  if (!(maybeUserId instanceof ValidationError)) {
    const userId = maybeUserId
    let account = await Accounts.getAccountFromUserId(userId)
    if (account instanceof CouldNotFindAccountFromKratosIdError) {
      account = await repairOrphanedIdentity({ userId, orphanError: account, logger })
    }
    if (account instanceof Error) {
      throw mapError(account)
    } else {
      domainAccount = account
      // not awaiting on purpose. just updating metadata
      // TODO: look if this can be a source of memory leaks
      Accounts.updateAccountIPsInfo({
        accountId: account.id,
        ip,
        logger,
      })

      if (sessionId && expiresAt) {
        maybeExtendSession({ sessionId, expiresAt })
      }

      const userRes = await UsersRepository().findById(account.kratosUserId)
      if (userRes instanceof Error) throw mapError(userRes)
      user = userRes
    }
  }

  const loaders = {
    txnMetadata: new DataLoader(async (keys) => {
      const txnMetadata = await Transactions.getTransactionsMetadataByIds(
        keys as LedgerTransactionId[],
      )
      if (txnMetadata instanceof IbexError) {
        recordExceptionInCurrentSpan({
          error: txnMetadata,
        })
        return keys.map(() => undefined)
      } else if (txnMetadata instanceof Error) {
        recordExceptionInCurrentSpan({
          error: txnMetadata,
          level: txnMetadata.level,
        })

        return keys.map(() => undefined)
      }

      return txnMetadata
    }),
  }

  return {
    logger,
    loaders,
    user,
    domainAccount,
    ip,
    sessionId,
    scopes,
    cashWalletClientCapabilities: DEFAULT_CASH_WALLET_CLIENT_CAPABILITIES,
  }
}
