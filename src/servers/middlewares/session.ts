import DataLoader from "dataloader"

import { Accounts, Transactions } from "@app"
import { DEFAULT_CASH_WALLET_CLIENT_CAPABILITIES } from "@app/cash-wallet-cutover"
import { recordExceptionInCurrentSpan } from "@services/tracing"
import jsonwebtoken from "jsonwebtoken"

import { getDefaultAccountsConfig } from "@config"

import { AuthenticationError } from "@graphql/error"
import { mapError } from "@graphql/error-map"

import { createAccountWithPhoneIdentifier } from "@app/accounts"
import { maybeExtendSession } from "@app/authentication"
import { checkedToUserId } from "@domain/accounts"
import {
  CouldNotFindAccountFromKratosIdError,
  DuplicateKeyForPersistError,
} from "@domain/errors"
import { ErrorLevel, ValidationError } from "@domain/shared"
import { IdentityRepository } from "@services/kratos"
import { baseLogger } from "@services/logger"
import { UsersRepository } from "@services/mongoose"
import { TwilioClient } from "@services/twilio"
import { IbexError } from "@services/ibex/errors"

type SessionLogger = typeof baseLogger

type OrphanRepairArgs = {
  userId: UserId
  orphanError: CouldNotFindAccountFromKratosIdError
  logger: SessionLogger
}

// The Kratos after-registration web_hook runs with `response.parse: false`:
// the identity is committed whether or not the api managed to write its
// account. A failed write (duplicate key, wallet provider down) therefore
// leaves a logged-in identity with no account, and every request it makes
// lands here. Re-run the registration write from the identity's own phone
// trait, including the Twilio carrier lookup the webhook path stores as
// `users.phoneMetadata`. If that is not possible the original not-found error
// stands and the caller answers it as "not authenticated" — it must never
// crash on it.
//
// Two pieces of replica-local state keep that from becoming a storm:
//
// - `inFlightRepairs` single-flights the repair per identity. An orphan
//   opening the app fires several queries in parallel; `accounts.kratosUserId`
//   is unique, so without this every request but one would lose the persistNew
//   race and be answered NOT_AUTHENTICATED (with a Critical span) on the very
//   launch that fixed the account. Requests landing mid-repair also never see
//   the half-initialised account (no defaultWalletId yet) — they wait for the
//   winner. A loser on ANOTHER replica is handled by re-reading the account
//   after a duplicate-key failure.
// - `failedRepairs` negative-caches an identity that could not be repaired
//   (phone collides on `users.phone`, no phone trait, Kratos unreachable).
//   Without it every request from that identity costs a Kratos admin read plus
//   two Mongo writes and emits a Critical span exception, and the mobile app's
//   pollers keep firing on NOT_AUTHENTICATED. One attempt per window; the
//   first failure is an error log with a Critical span, later ones warn.
const REPAIR_RETRY_WINDOW_MS = 60_000

const inFlightRepairs = new Map<UserId, Promise<Account | RepositoryError>>()
const failedRepairs = new Map<UserId, { retryAfter: number; failures: number }>()

// The maps above live for the process; specs reset them between cases.
export const clearOrphanRepairState = (): void => {
  inFlightRepairs.clear()
  failedRepairs.clear()
}

const recordRepairFailure = ({
  userId,
  cause,
  reason,
  orphanError,
  logger,
}: OrphanRepairArgs & {
  cause: Error | undefined
  reason: string
}): CouldNotFindAccountFromKratosIdError => {
  const failures = (failedRepairs.get(userId)?.failures ?? 0) + 1
  failedRepairs.set(userId, {
    retryAfter: Date.now() + REPAIR_RETRY_WINDOW_MS,
    failures,
  })

  const isFirstFailure = failures === 1
  const attributes = { kratosUserId: userId, repairFailures: failures }
  recordExceptionInCurrentSpan({
    error: cause ?? orphanError,
    level: isFirstFailure ? ErrorLevel.Critical : ErrorLevel.Warn,
    attributes,
  })

  const details = { err: cause, ...attributes, retryAfterMs: REPAIR_RETRY_WINDOW_MS }
  const msg = `orphaned kratos identity: ${reason}`
  if (isFirstFailure) {
    logger.error(details, msg)
  } else {
    logger.warn(details, msg)
  }

  return orphanError
}

const attemptRepair = async ({
  userId,
  orphanError,
  logger,
}: OrphanRepairArgs): Promise<Account | RepositoryError> => {
  const identity = await IdentityRepository().getIdentity(userId)
  if (identity instanceof Error) {
    return recordRepairFailure({
      userId,
      cause: identity,
      reason: "could not load identity",
      orphanError,
      logger,
    })
  }

  if (!identity.phone) {
    return recordRepairFailure({
      userId,
      cause: undefined,
      reason: "no phone trait to repair from",
      orphanError,
      logger,
    })
  }

  // The webhook path stores the Twilio carrier lookup on the users row
  // (login.ts → transient_payload → RegistrationPayloadValidator). Rewards
  // (add-earn) fail closed on a missing phoneMetadata, so a repair without it
  // would leave the account permanently ineligible with nothing pointing at
  // why. Best effort, as on the webhook path: a lookup failure must not fail
  // the repair, it just gets the warn line below so the gap is attributable.
  const carrier = await TwilioClient().getCarrier(identity.phone)
  if (carrier instanceof Error) {
    logger.warn(
      { err: carrier, kratosUserId: userId },
      "orphaned kratos identity: carrier lookup failed, repairing without phone metadata",
    )
  }

  const created = await createAccountWithPhoneIdentifier({
    newAccountInfo: { kratosUserId: userId, phone: identity.phone },
    config: getDefaultAccountsConfig(),
    phoneMetadata: carrier instanceof Error ? undefined : carrier,
  })

  if (created instanceof DuplicateKeyForPersistError) {
    // Lost the persistNew race to a request on another replica: its account
    // is the one to use. If the account is still missing the collision was
    // on users.phone instead, and the failure stands.
    const existing = await Accounts.getAccountFromUserId(userId)
    if (!(existing instanceof Error)) {
      failedRepairs.delete(userId)
      logger.warn(
        { kratosUserId: userId, accountId: existing.id },
        "orphaned kratos identity repaired by a concurrent request",
      )
      return existing
    }
  }

  if (created instanceof Error) {
    return recordRepairFailure({
      userId,
      cause: created,
      reason: "repair failed",
      orphanError,
      logger,
    })
  }

  failedRepairs.delete(userId)
  logger.warn(
    { kratosUserId: userId, accountId: created.id },
    "orphaned kratos identity repaired",
  )
  return created
}

const repairOrphanedIdentity = ({
  userId,
  orphanError,
  logger,
}: OrphanRepairArgs): Promise<Account | RepositoryError> => {
  const failed = failedRepairs.get(userId)
  if (failed && Date.now() < failed.retryAfter) {
    logger.debug(
      {
        kratosUserId: userId,
        repairFailures: failed.failures,
        retryAfter: new Date(failed.retryAfter),
      },
      "orphaned kratos identity: repair skipped, last attempt failed recently",
    )
    return Promise.resolve(orphanError)
  }

  const inFlight = inFlightRepairs.get(userId)
  if (inFlight) return inFlight

  const repair = attemptRepair({ userId, orphanError, logger }).finally(() => {
    inFlightRepairs.delete(userId)
  })
  inFlightRepairs.set(userId, repair)
  return repair
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
    if (account instanceof CouldNotFindAccountFromKratosIdError) {
      // Only here is the missing account known to be the caller's own. The
      // session is unusable until one exists, which the client reads as
      // NOT_AUTHENTICATED rather than "unexpected error, please try again".
      // Anywhere else (admin lookups of other users) the same domain error
      // is a plain not-found — see mapError.
      throw new AuthenticationError({
        message: "No account is linked to this session",
        logger,
      })
    }
    if (account instanceof Error) {
      throw mapError(account)
    }

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
