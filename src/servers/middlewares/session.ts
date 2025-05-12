import DataLoader from "dataloader"

import { Accounts, Transactions } from "@app"
import { recordExceptionInCurrentSpan } from "@services/tracing"
import jsonwebtoken from "jsonwebtoken"

import { mapError } from "@graphql/error-map"

import { maybeExtendSession } from "@app/authentication"
import { checkedToUserId } from "@domain/accounts"
import { ValidationError } from "@domain/shared"
import { baseLogger } from "@services/logger"
import { UsersRepository } from "@services/mongoose"
import { IbexError } from "@services/ibex/errors"

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
  const tokenType = tokenPayload?.type

  // note: value should match (ie: "anon") if not an accountId
  // settings from dev/ory/oathkeeper.yml/authenticator/anonymous/config/subjet
  const maybeUserId = checkedToUserId(tokenPayload?.sub ?? "")

  if (!(maybeUserId instanceof ValidationError)) {
    const userId = maybeUserId
    const account = await Accounts.getAccountFromUserId(userId)
    if (account instanceof Error) {
      throw mapError(account)
    } else {
      domainAccount = account

      // Don't update IP info for service token requests
      if (tokenType !== "service") {
        // not awaiting on purpose. just updating metadata
        // TODO: look if this can be a source of memory leaks
        Accounts.updateAccountIPsInfo({
          accountId: account.id,
          ip,
          logger,
        })

        // Only extend session for regular tokens, not service tokens
        if (sessionId && expiresAt) {
          maybeExtendSession({ sessionId, expiresAt })
        }
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
      }
      else if (txnMetadata instanceof Error) {
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
  }
}
