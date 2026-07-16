/**
 * Binds Bridge-issued Plaid link tokens to the Flash account that requested them.
 * Tokens live only as long as Bridge says they do; exchange rejects strangers / reuse.
 */

import { CacheServiceError, CacheUndefinedError } from "@domain/cache"
import { RedisCacheService, consumeCacheKey } from "@services/cache"

import { BridgeInvalidPlaidTokenError } from "./errors"

export type PlaidLinkTokenBinding = {
  accountId: AccountId
  bridgeCustomerId: string
  expiresAt: string
}

const KEY_PREFIX = "plaid:link:"
/** Plaid’s default link_token lifetime when expires_at is unparsable. */
const FALLBACK_TTL_SECS = 4 * 60 * 60

const cacheKey = (linkToken: string): string => `${KEY_PREFIX}${linkToken}`

const ttlSecsFromExpiresAt = (expiresAt: string): Seconds => {
  const ms = Date.parse(expiresAt)
  if (Number.isNaN(ms)) return FALLBACK_TTL_SECS as Seconds
  const secs = Math.floor((ms - Date.now()) / 1000)
  return Math.max(1, secs) as Seconds
}

export const PlaidLinkTokenStore = {
  save: async (
    linkToken: string,
    binding: PlaidLinkTokenBinding,
  ): Promise<true | CacheServiceError> => {
    const result = await RedisCacheService().set({
      key: cacheKey(linkToken),
      value: binding,
      ttlSecs: ttlSecsFromExpiresAt(binding.expiresAt),
    })
    if (result instanceof CacheServiceError) return result
    return true
  },

  /**
   * Load binding, enforce ownership, then atomically consume so the token is
   * one-time-use even under concurrent exchanges (see consumeCacheKey). Ownership
   * is checked on a non-destructive read, so a stranger cannot burn the owner's
   * token by attempting to exchange it.
   */
  consumeForAccount: async (
    linkToken: string,
    accountId: AccountId,
  ): Promise<
    PlaidLinkTokenBinding | BridgeInvalidPlaidTokenError | CacheServiceError
  > => {
    const key = cacheKey(linkToken)
    const cached = await RedisCacheService().get<PlaidLinkTokenBinding>({ key })

    if (cached instanceof CacheUndefinedError) {
      return new BridgeInvalidPlaidTokenError(
        "Unknown or already-used Plaid link token — restart bank linking",
      )
    }
    if (cached instanceof CacheServiceError) return cached

    if (cached.accountId !== accountId) {
      return new BridgeInvalidPlaidTokenError(
        "Plaid link token was not issued for this account — restart bank linking",
      )
    }

    const expiresMs = Date.parse(cached.expiresAt)
    if (!Number.isNaN(expiresMs) && expiresMs <= Date.now()) {
      await RedisCacheService().clear({ key })
      return new BridgeInvalidPlaidTokenError(
        "Plaid link token has expired — restart bank linking",
      )
    }

    // Atomic single-use gate. A plain get-then-clear is a TOCTOU race: two
    // concurrent exchanges of the same token can both read the binding before
    // either clears it, so both would proceed. consumeCacheKey issues one DEL
    // and returns true only for the caller that actually removed the key — among
    // concurrent exchanges of the same token, exactly one wins; the rest are
    // rejected here, before the Bridge call.
    const consumed = await consumeCacheKey({ key })
    if (consumed instanceof CacheServiceError) return consumed
    if (!consumed) {
      return new BridgeInvalidPlaidTokenError(
        "Unknown or already-used Plaid link token — restart bank linking",
      )
    }
    return cached
  },
}
