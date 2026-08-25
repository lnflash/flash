/**
 * The npub repository layer added by this PR is almost entirely index- and
 * filter-shaped, and a mocked mongoose model cannot report on any of it: the
 * unit specs assert that `claimNpub` passes `{ npub: { $not: { $type:
 * "string" } } }` and that the schema declares a unique partial index, but
 * nothing there executes either against a database. If the filter were wrong,
 * the guard would be silently inert — a reassignment onto a legacy `npub:
 * null` account would come back `AccountAlreadyHasNpubError` forever — and the
 * unit suite would stay green.
 *
 * These run against the real collection, so they can return "no" about the
 * three claims the comments make:
 *
 *  - `$not: { $type: "string" }` rather than `$exists: false`, because legacy
 *    documents predating the partial index hold an explicit `npub: null` and
 *    that is not a claim (`accounts.ts` `claimNpub`, `release-npub.ts`).
 *  - the unique partial index is what makes a concurrent claim of the same key
 *    fail rather than duplicate (`schema.ts`, migration
 *    20260824120000-accounts-unique-npub).
 *  - `findByNpub` reaches that index instead of scanning the collection
 *    (`accounts.ts`). This one already came back "no" once: dropping the
 *    collation was not sufficient, because mongo will not use an index whose
 *    partial filter is `$type`-shaped for a bare equality.
 */
import mongoose from "mongoose"

import { releaseNpub } from "@app/accounts/release-npub"
import {
  CouldNotFindAccountFromNpubError,
  DuplicateKeyForPersistError,
  NoNpubToReleaseError,
} from "@domain/errors"
import { AccountAlreadyHasNpubError, checkedToNpub } from "@domain/nostr"
import { AccountsRepository } from "@services/mongoose"
import { Account as AccountModel } from "@services/mongoose/schema"
import { toObjectId } from "@services/mongoose/utils"

import { createUser } from "test/galoy/helpers"

const SUPPORT_USER_ID = "support-user-id" as UserId

// bech32's charset — "1", "b", "i" and "o" are excluded. Values only have to be
// unique and well-formed; nothing here decodes them.
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
const RUN = BigInt(Math.floor(Math.random() * 2 ** 40))
let minted = 0n

const uniqueNpub = (): Npub => {
  let remaining = RUN * 1_000_000n + minted++
  let body = ""
  while (remaining > 0n) {
    body = CHARSET[Number(remaining % 32n)] + body
    remaining /= 32n
  }
  // Minted through the same checker the GraphQL boundary uses, so a value that
  // would not survive validation cannot make these tests pass.
  const npub = checkedToNpub(`npub1${body.padStart(58, CHARSET[0])}`)
  if (npub instanceof Error) throw npub
  return npub
}

const newAccountId = async (): Promise<AccountId> => {
  const user = await createUser()
  return user.account.id
}

// Legacy shape: written before the partial index existed, so it can hold an
// explicit null. `setNpub` never produces this — only direct mongo does.
const setLegacyNullNpub = async (accountId: AccountId) => {
  await AccountModel.collection.updateOne(
    { _id: toObjectId<AccountId>(accountId) },
    { $set: { npub: null } },
  )
}

const npubOf = async (accountId: AccountId): Promise<unknown> => {
  const doc = await AccountModel.collection.findOne({
    _id: toObjectId<AccountId>(accountId),
  })
  return doc?.npub
}

const claim = async (accountId: AccountId, npub: Npub) => {
  const claimed = await AccountsRepository().claimNpub(accountId, npub)
  if (claimed instanceof Error) throw claimed
  return claimed
}

// The filter the repository actually handed mongo, rather than one restated in
// the test. Mongoose's debug hook is the only seam that reports it without
// re-opening the connection with `monitorCommands`.
const captureFilter = async (
  run: () => Promise<unknown>,
): Promise<Record<string, unknown>> => {
  const sent: Record<string, unknown>[] = []
  mongoose.set(
    "debug",
    (collectionName: string, methodName: string, ...args: unknown[]) => {
      if (
        collectionName === AccountModel.collection.collectionName &&
        methodName === "findOne"
      ) {
        sent.push(args[0] as Record<string, unknown>)
      }
    },
  )
  try {
    await run()
  } finally {
    mongoose.set("debug", false)
  }
  if (sent.length !== 1) {
    throw new Error(`expected exactly one findOne, saw ${sent.length}`)
  }
  return sent[0]
}

describe("accounts npub persistence", () => {
  it("has the unique partial index on the live collection", async () => {
    // `schema.ts` declaring it is not the same as mongo holding it, and every
    // other assertion below leans on the real index existing.
    const indexes = (await AccountModel.collection.indexes()) as Record<string, unknown>[]
    const npubIndex = indexes.find(
      (idx) => JSON.stringify(idx.key) === JSON.stringify({ npub: 1 }),
    )

    expect(npubIndex).toBeDefined()
    expect(npubIndex?.unique).toBe(true)
    expect(npubIndex?.partialFilterExpression).toEqual({ npub: { $type: "string" } })
  })

  describe("claimNpub", () => {
    it("lands on an account with no npub field", async () => {
      const accountId = await newAccountId()
      const npub = uniqueNpub()

      const result = await AccountsRepository().claimNpub(accountId, npub)

      expect(result).not.toBeInstanceOf(Error)
      expect((result as Account).npub).toBe(npub)
      expect(await npubOf(accountId)).toBe(npub)
    })

    it("lands on an account holding a legacy explicit null", async () => {
      // The case `$not: { $type: "string" }` exists for. `$exists: false` would
      // refuse here, and the account could never receive a key again.
      const accountId = await newAccountId()
      await setLegacyNullNpub(accountId)
      const npub = uniqueNpub()

      const result = await AccountsRepository().claimNpub(accountId, npub)

      expect(result).not.toBeInstanceOf(Error)
      expect(await npubOf(accountId)).toBe(npub)
    })

    it("refuses an account already holding a key, and leaves that key alone", async () => {
      const accountId = await newAccountId()
      const held = uniqueNpub()
      await claim(accountId, held)

      const result = await AccountsRepository().claimNpub(accountId, uniqueNpub())

      expect(result).toBeInstanceOf(AccountAlreadyHasNpubError)
      // The unique index cannot catch an overwrite — only the filter can. If
      // the guard were inert this would be the new key, and the old one would
      // be unclaimed with nothing logging it.
      expect(await npubOf(accountId)).toBe(held)
    })

    it("reports a duplicate when a second account claims the same key", async () => {
      const first = await newAccountId()
      const second = await newAccountId()
      const npub = uniqueNpub()

      await claim(first, npub)

      const result = await AccountsRepository().claimNpub(second, npub)

      expect(result).toBeInstanceOf(DuplicateKeyForPersistError)
      expect(await npubOf(second)).toBeUndefined()
    })

    it("lets two accounts hold a legacy null without colliding", async () => {
      // `partialFilterExpression` rather than `sparse`: a sparse index would
      // index both nulls and reject the second one.
      const first = await newAccountId()
      const second = await newAccountId()

      await setLegacyNullNpub(first)
      await setLegacyNullNpub(second)

      expect(await npubOf(first)).toBeNull()
      expect(await npubOf(second)).toBeNull()
    })
  })

  describe("findByNpub", () => {
    it("resolves the claiming account", async () => {
      const accountId = await newAccountId()
      const npub = uniqueNpub()
      await claim(accountId, npub)

      const found = await AccountsRepository().findByNpub(npub)

      expect(found).not.toBeInstanceOf(Error)
      expect((found as Account).id).toBe(accountId)
    })

    it("reports an unclaimed key rather than an arbitrary account", async () => {
      expect(await AccountsRepository().findByNpub(uniqueNpub())).toBeInstanceOf(
        CouldNotFindAccountFromNpubError,
      )
    })

    it("uses the index rather than scanning the collection", async () => {
      // Dropping the case-insensitive collation was supposed to make this
      // lookup an index hit — it is the support desk's identity resolver and
      // runs on every inbound nostr DM, plus once per `setNpub` as the
      // duplicate probe. The collation was only half of it: the index is
      // partial on `{ npub: { $type: "string" } }`, and mongo will not pick a
      // partial index unless the query provably matches a subset of that
      // filter, which it cannot derive from a bare equality. `{ npub: { $eq }
      // }` alone plans as a COLLSCAN on 6.0.
      //
      // The plan is taken from the filter the repository actually sent, not
      // one restated here — restating it would pass no matter what
      // `findByNpub` does.
      const probe = uniqueNpub()
      const sent = await captureFilter(() => AccountsRepository().findByNpub(probe))

      const plan = (await AccountModel.collection
        .find(sent)
        .explain("queryPlanner")) as unknown as {
        queryPlanner: { winningPlan: unknown }
      }

      expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain("IXSCAN")
    })
  })

  describe("unsetNpub", () => {
    it("removes the field and reports the key it freed", async () => {
      const accountId = await newAccountId()
      const npub = uniqueNpub()
      await claim(accountId, npub)

      const released = await AccountsRepository().unsetNpub(accountId)

      expect(released).not.toBeInstanceOf(Error)
      expect((released as NpubUnset).previousNpub).toBe(npub)
      // Removed, not blanked: the partial index only covers strings, so a null
      // left behind would sit unindexed and keep failing lookups.
      expect(await npubOf(accountId)).toBeUndefined()
      expect(await AccountsRepository().findByNpub(npub)).toBeInstanceOf(
        CouldNotFindAccountFromNpubError,
      )
    })

    it("frees the key for whoever actually holds the secret key", async () => {
      const squatter = await newAccountId()
      const owner = await newAccountId()
      const npub = uniqueNpub()
      await claim(squatter, npub)

      const released = await AccountsRepository().unsetNpub(squatter)
      if (released instanceof Error) throw released

      expect(await AccountsRepository().claimNpub(owner, npub)).not.toBeInstanceOf(Error)
    })

    it("refuses an account holding a legacy explicit null", async () => {
      const accountId = await newAccountId()
      await setLegacyNullNpub(accountId)

      expect(await AccountsRepository().unsetNpub(accountId)).toBeInstanceOf(
        NoNpubToReleaseError,
      )
    })

    it("refuses an account that held nothing", async () => {
      const accountId = await newAccountId()

      expect(await AccountsRepository().unsetNpub(accountId)).toBeInstanceOf(
        NoNpubToReleaseError,
      )
    })
  })

  describe("releaseNpub with reassignment", () => {
    it("moves the key to a target that never held one", async () => {
      const squatter = await newAccountId()
      const owner = await newAccountId()
      const npub = uniqueNpub()
      await claim(squatter, npub)

      const result = await releaseNpub({
        id: squatter,
        releasedByUserId: SUPPORT_USER_ID,
        reassignToAccountId: owner,
      })

      expect(result).not.toBeInstanceOf(Error)
      expect(result).toMatchObject({ previousNpub: npub, reassignedTo: { id: owner } })
      expect(await npubOf(squatter)).toBeUndefined()
      expect(await npubOf(owner)).toBe(npub)
    })

    it("moves the key to a target holding a legacy explicit null", async () => {
      // The end-to-end shape of the bug the `$not: { $type: "string" }` filter
      // and the `typeof` pre-check exist to avoid: an owner whose account
      // predates the partial index would otherwise be told
      // `AccountAlreadyHasNpubError` forever, with the key already released.
      const squatter = await newAccountId()
      const owner = await newAccountId()
      await setLegacyNullNpub(owner)
      const npub = uniqueNpub()
      await claim(squatter, npub)

      const result = await releaseNpub({
        id: squatter,
        releasedByUserId: SUPPORT_USER_ID,
        reassignToAccountId: owner,
      })

      expect(result).not.toBeInstanceOf(Error)
      expect(result).not.toMatchObject({ reassignmentError: expect.anything() })
      expect(await npubOf(owner)).toBe(npub)
    })

    it("refuses a target already holding a key, before freeing anything", async () => {
      const squatter = await newAccountId()
      const owner = await newAccountId()
      const npub = uniqueNpub()
      const ownerNpub = uniqueNpub()
      await claim(squatter, npub)
      await claim(owner, ownerNpub)

      const result = await releaseNpub({
        id: squatter,
        releasedByUserId: SUPPORT_USER_ID,
        reassignToAccountId: owner,
      })

      expect(result).toBeInstanceOf(AccountAlreadyHasNpubError)
      // Nothing was freed — re-running with a different target must still work.
      expect(await npubOf(squatter)).toBe(npub)
      expect(await npubOf(owner)).toBe(ownerNpub)
    })
  })
})
