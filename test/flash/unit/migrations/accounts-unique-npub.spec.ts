/* eslint @typescript-eslint/no-var-requires: "off" */

/**
 * The two destructive branches of the `accounts.npub` migration — case
 * normalisation and duplicate release — are unreachable in CI: `make
 * test-migrate` runs against a clean database, so the collection is empty and
 * both branches short-circuit. Without this file, the first execution of
 * `$unset: { npub: "" }` would be against real customer identities.
 *
 * The stub below is a miniature mongo: `updateMany` actually mutates the
 * documents, so the pipeline's ordering (lowercase, then group) is exercised
 * rather than asserted on canned return values.
 */

type Doc = {
  _id: string
  id: string
  npub?: string
  created_at?: string
}

type IndexSpec = { name: string; unique?: boolean; key: Record<string, number> }

const isDuplicatePipeline = (pipeline: Record<string, unknown>[]) =>
  pipeline.some((stage) => "$group" in stage)

const makeDb = ({ docs, indexes }: { docs: Doc[]; indexes?: IndexSpec[] }) => {
  const state = { docs, indexes: indexes ?? ([] as IndexSpec[]) }

  const aggregate = jest.fn((pipeline: Record<string, unknown>[]) => ({
    toArray: async () => {
      const withNpub = state.docs.filter((d) => typeof d.npub === "string")

      if (!isDuplicatePipeline(pipeline)) {
        return withNpub
          .filter((d) => d.npub !== (d.npub as string).toLowerCase())
          .map((d) => ({ _id: d._id, id: d.id, npub: d.npub }))
      }

      const groups = new Map<string, Doc[]>()
      for (const d of withNpub) {
        const key = d.npub as string
        groups.set(key, [...(groups.get(key) ?? []), d])
      }
      return [...groups.entries()]
        .filter(([, members]) => members.length > 1)
        .map(([npub, members]) => ({
          _id: npub,
          count: members.length,
          docs: members.map((d) => ({
            _id: d._id,
            id: d.id,
            created_at: d.created_at,
          })),
        }))
    },
  }))

  const updateMany = jest.fn(
    async (
      filter: { _id: { $in: string[] } },
      update: Record<string, unknown> | Record<string, unknown>[],
    ) => {
      const targeted = filter._id.$in
      state.docs = state.docs.map((doc) => {
        if (!targeted.includes(doc._id)) return doc
        if (Array.isArray(update)) return { ...doc, npub: doc.npub?.toLowerCase() }
        const released = { ...doc }
        delete released.npub
        return released
      })
      return { modifiedCount: targeted.length }
    },
  )

  const createIndex = jest.fn(
    async (key: Record<string, number>, opts: { name: string; unique?: boolean }) => {
      state.indexes = [...state.indexes, { key, ...opts }]
      return opts.name
    },
  )

  const dropIndex = jest.fn(async (name: string) => {
    state.indexes = state.indexes.filter((idx) => idx.name !== name)
  })

  const collection = jest.fn(() => ({
    aggregate,
    updateMany,
    createIndex,
    dropIndex,
    indexes: async () => state.indexes,
  }))

  const db = {
    collection,
    listCollections: () => ({ toArray: async () => [{ name: "accounts" }] }),
  }

  return { db, state, aggregate, updateMany, createIndex, dropIndex }
}

const migration = require("../../../../src/migrations/20260824120000-accounts-unique-npub")

const LOWER = "npub1" + "q".repeat(58)
const MIXED = "npub1" + "Q".repeat(58)

describe("migration: accounts unique npub", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("lowercases only the offending documents", async () => {
    const { db, state, updateMany } = makeDb({
      docs: [
        { _id: "1", id: "acct-1", npub: MIXED, created_at: "2024-01-01" },
        {
          _id: "2",
          id: "acct-2",
          npub: "npub1" + "z".repeat(58),
          created_at: "2024-01-01",
        },
      ],
    })

    await migration.up(db)

    expect(state.docs.find((d) => d._id === "1")?.npub).toEqual(LOWER)
    // The write is scoped to the ids the audit scan found — not to every
    // npub-bearing account, which would churn the oplog for zero repairs.
    expect(updateMany).toHaveBeenCalledWith({ _id: { $in: ["1"] } }, [
      { $set: { npub: { $toLower: "$npub" } } },
    ])
  })

  it("does not write at all when every npub is already lowercase", async () => {
    const { db, updateMany } = makeDb({
      docs: [{ _id: "1", id: "acct-1", npub: LOWER, created_at: "2024-01-01" }],
    })

    await migration.up(db)

    expect(updateMany).not.toHaveBeenCalled()
  })

  it("lowercases before the duplicate scan, so case-variant collisions are caught", async () => {
    const { db, state } = makeDb({
      docs: [
        { _id: "1", id: "acct-1", npub: MIXED, created_at: "2024-01-01" },
        { _id: "2", id: "acct-2", npub: LOWER, created_at: "2025-01-01" },
      ],
    })

    await migration.up(db)

    // Same key once normalised — both must be released.
    expect(state.docs.every((d) => d.npub === undefined)).toBe(true)
  })

  it("releases the npub from EVERY account in a duplicate group, including the oldest", async () => {
    // Picking a winner by created_at is unrecoverable when it picks wrong:
    // `setNpub` refuses an already-claimed npub and no admin mutation can
    // release one, so the loser could never re-link.
    const { db, state, updateMany } = makeDb({
      docs: [
        { _id: "old", id: "acct-old", npub: LOWER, created_at: "2024-01-01" },
        { _id: "new", id: "acct-new", npub: LOWER, created_at: "2025-01-01" },
      ],
    })

    await migration.up(db)

    expect(state.docs.map((d) => d.npub)).toEqual([undefined, undefined])
    expect(updateMany).toHaveBeenCalledWith(
      { _id: { $in: ["old", "new"] } },
      { $unset: { npub: "" } },
    )
  })

  it("leaves uncontested npubs alone", async () => {
    const { db, state } = makeDb({
      docs: [
        { _id: "1", id: "acct-1", npub: LOWER, created_at: "2024-01-01" },
        {
          _id: "2",
          id: "acct-2",
          npub: "npub1" + "z".repeat(58),
          created_at: "2024-01-01",
        },
        { _id: "3", id: "acct-3", created_at: "2024-01-01" },
      ],
    })

    await migration.up(db)

    expect(state.docs.map((d) => d.npub)).toEqual([
      LOWER,
      "npub1" + "z".repeat(58),
      undefined,
    ])
  })

  it("creates the unique index with the string-typed partial filter", async () => {
    const { db, createIndex } = makeDb({ docs: [] })

    await migration.up(db)

    // `sparse: true` would still index documents holding an explicit
    // `npub: null`, and the second such document would collide.
    expect(createIndex).toHaveBeenCalledWith(
      { npub: 1 },
      {
        unique: true,
        name: "npub_1",
        partialFilterExpression: { npub: { $type: "string" } },
      },
    )
  })

  it("drops a stale non-unique npub_1 before creating the unique one", async () => {
    const { db, dropIndex, state } = makeDb({
      docs: [],
      indexes: [{ name: "npub_1", key: { npub: 1 } }],
    })

    await migration.up(db)

    expect(dropIndex).toHaveBeenCalledWith("npub_1")
    expect(state.indexes.filter((i) => i.name === "npub_1")).toEqual([
      {
        key: { npub: 1 },
        unique: true,
        name: "npub_1",
        partialFilterExpression: { npub: { $type: "string" } },
      },
    ])
  })

  it("down drops the unique index and leaves the data repairs in place", async () => {
    const { db, state, updateMany } = makeDb({
      docs: [{ _id: "1", id: "acct-1", created_at: "2024-01-01" }],
      indexes: [{ name: "npub_1", key: { npub: 1 }, unique: true }],
    })

    await migration.down(db)

    expect(state.indexes).toEqual([])
    expect(updateMany).not.toHaveBeenCalled()
  })
})
