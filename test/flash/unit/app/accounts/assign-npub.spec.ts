/**
 * `releaseNpub` is two writes and no transaction. When the second one fails the
 * key is unclaimed and the account it came off no longer holds it, so
 * `accountReleaseNpub` cannot be re-run against it. `assignNpub` is that second
 * write on its own — the only admin path that can finish a half-applied
 * reassignment before the squatter's poller re-takes the key.
 */
const claimNpub = jest.fn()
const info = jest.fn()
const error = jest.fn()

jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({ claimNpub }),
}))

jest.mock("@services/logger", () => ({
  baseLogger: {
    info: (...args: unknown[]) => info(...args),
    warn: jest.fn(),
    error: (...args: unknown[]) => error(...args),
  },
}))

import { InvalidAccountIdError } from "@domain/accounts"
import {
  CouldNotFindAccountFromIdError,
  DuplicateKeyForPersistError,
  UnknownRepositoryError,
} from "@domain/errors"
import {
  AccountAlreadyHasNpubError,
  InvalidNpubError,
  NpubNotAvailableError,
} from "@domain/nostr"
import { assignNpub } from "@app/accounts/assign-npub"

const ACCOUNT_ID = "5f4c9a2b1e7d3f8a6b0c4d2e" as AccountId
const SUPPORT_USER_ID = "support-user-id" as UserId
const NPUB = `npub1${"q".repeat(58)}`

const assign = (overrides: Record<string, unknown> = {}) =>
  assignNpub({
    id: ACCOUNT_ID,
    npub: NPUB,
    assignedByUserId: SUPPORT_USER_ID,
    ...overrides,
  })

describe("assignNpub", () => {
  beforeEach(() => jest.clearAllMocks())

  it("claims the key for the account and returns it", async () => {
    const account = { id: ACCOUNT_ID, npub: NPUB }
    claimNpub.mockResolvedValue(account)

    const result = await assign()

    expect(claimNpub).toHaveBeenCalledWith(ACCOUNT_ID, NPUB)
    expect(result).toBe(account)
  })

  it("records who assigned the key", async () => {
    claimNpub.mockResolvedValue({ id: ACCOUNT_ID, npub: NPUB })

    await assign()

    // The admin server never assigns req.gqlContext, so this line is the only
    // record that an admin moved a key.
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        npub: NPUB,
        assignedByUserId: SUPPORT_USER_ID,
      }),
      expect.any(String),
    )
  })

  it("rejects a malformed account id before touching the repository", async () => {
    const result = await assign({ id: "not-an-object-id" })

    expect(result).toBeInstanceOf(InvalidAccountIdError)
    expect(claimNpub).not.toHaveBeenCalled()
  })

  it("rejects a malformed npub before touching the repository", async () => {
    const result = await assign({ npub: "not-an-npub" })

    expect(result).toBeInstanceOf(InvalidNpubError)
    expect(claimNpub).not.toHaveBeenCalled()
  })

  it("reports a key held by someone else as unavailable, not as a raw duplicate", async () => {
    // Same mapping the reassignment path uses, so one cause reads identically
    // wherever it surfaces.
    claimNpub.mockResolvedValue(new DuplicateKeyForPersistError())

    const result = await assign()

    expect(result).toBeInstanceOf(NpubNotAvailableError)
  })

  it("refuses rather than overwriting when the target already holds a key", async () => {
    claimNpub.mockResolvedValue(new AccountAlreadyHasNpubError(ACCOUNT_ID))

    const result = await assign()

    expect(result).toBeInstanceOf(AccountAlreadyHasNpubError)
  })

  it("passes through a missing account", async () => {
    claimNpub.mockResolvedValue(new CouldNotFindAccountFromIdError(ACCOUNT_ID))

    const result = await assign()

    expect(result).toBeInstanceOf(CouldNotFindAccountFromIdError)
  })

  it("logs every refusal, so a token sweeping account ids cannot probe silently", async () => {
    claimNpub.mockResolvedValue(new UnknownRepositoryError())

    await assign()

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        assignedByUserId: SUPPORT_USER_ID,
      }),
      expect.any(String),
    )
  })
})
