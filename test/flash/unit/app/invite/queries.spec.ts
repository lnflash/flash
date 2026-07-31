import { CouldNotFindError } from "@domain/errors"

const mockFindById = jest.fn()
const mockAggregate = jest.fn()
jest.mock("@services/mongoose/models/invite", () => {
  const actual = jest.requireActual("@services/mongoose/models/invite")
  return {
    InviteMethod: actual.InviteMethod,
    InviteStatus: actual.InviteStatus,
    InviteRepository: {
      findById: (...args: unknown[]) => mockFindById(...args),
      aggregate: (...args: unknown[]) => mockAggregate(...args),
    },
  }
})

const mockAccountFindById = jest.fn()
jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({ findById: mockAccountFindById }),
}))

import { getInviteById, listInvites } from "@app/invite/queries"
import { InviteStatus, InviteMethod } from "@services/mongoose/models/invite"

const INVITER = "507f1f77bcf86cd799439011"
const REDEEMER = "507f1f77bcf86cd799439022"

describe("getInviteById", () => {
  beforeEach(() => jest.clearAllMocks())

  it("returns CouldNotFindError when the invite is missing", async () => {
    mockFindById.mockResolvedValue(null)
    const result = await getInviteById("507f1f77bcf86cd799439011" as never)
    expect(result).toBeInstanceOf(CouldNotFindError)
  })

  it("returns the invite with the inviter's username for a pending invite", async () => {
    mockFindById.mockResolvedValue({
      _id: { toString: () => "invite-1" },
      contact: "friend@example.com",
      method: InviteMethod.EMAIL,
      status: InviteStatus.SENT,
      inviterId: { toString: () => INVITER },
      createdAt: new Date("2026-01-01"),
      expiresAt: new Date("2026-01-02"),
    })
    mockAccountFindById.mockResolvedValueOnce({ id: INVITER, username: "alice" })

    const result = await getInviteById("507f1f77bcf86cd799439011" as never)

    expect(result).toMatchObject({
      id: "invite-1",
      contact: "friend@example.com",
      inviterUsername: "alice",
      status: InviteStatus.SENT,
    })
  })

  it("includes redeemer details for an accepted invite", async () => {
    mockFindById.mockResolvedValue({
      _id: { toString: () => "invite-2" },
      contact: "+12025550123",
      method: InviteMethod.WHATSAPP,
      status: InviteStatus.ACCEPTED,
      inviterId: { toString: () => INVITER },
      redeemedById: { toString: () => REDEEMER },
      createdAt: new Date(),
      expiresAt: new Date(),
      redeemedAt: new Date(),
    })
    mockAccountFindById
      .mockResolvedValueOnce({ id: INVITER, username: "alice" })
      .mockResolvedValueOnce({ id: REDEEMER, username: "bob" })

    const result = await getInviteById("507f1f77bcf86cd799439011" as never)

    expect(result).toMatchObject({
      redeemerAccountId: REDEEMER,
      redeemerUsername: "bob",
    })
  })
})

describe("listInvites", () => {
  beforeEach(() => jest.clearAllMocks())

  it("returns the paginated facet result", async () => {
    const data = [{ id: "a" }, { id: "b" }]
    mockAggregate.mockResolvedValue([{ data, count: [{ total: 2 }] }])

    const result = await listInvites({ first: 10 })

    expect(result).toEqual({ data, count: [{ total: 2 }] })
    expect(mockAggregate).toHaveBeenCalledTimes(1)
  })

  it("pages by _id cursor without restricting the total count", async () => {
    mockAggregate.mockResolvedValue([{ data: [], count: [{ total: 9 }] }])
    const afterId = "507f1f77bcf86cd799439033"

    await listInvites({ first: 5, afterId })

    const pipeline = mockAggregate.mock.calls[0][0]
    // The cursor restriction lives inside the data facet (older than afterId,
    // newest first) — never in the shared $match, so count covers everything.
    expect(pipeline[0]).toEqual({ $match: {} })
    const dataPipeline = pipeline[1].$facet.data
    expect(dataPipeline[0].$match._id.$lt.toString()).toBe(afterId)
    expect(dataPipeline[1]).toEqual({ $sort: { _id: -1 } })
    expect(dataPipeline[2]).toEqual({ $limit: 5 })
  })

  it("defaults data and count when the facet result omits them", async () => {
    // NB: the `|| [{ total: 0 }]` fallback only fires for a missing key, not an
    // empty array — an empty `count: []` from aggregate passes straight through.
    mockAggregate.mockResolvedValue([{}])
    const result = await listInvites({})
    expect(result).toEqual({ data: [], count: [{ total: 0 }] })
  })

  it("filters by status and casts inviterId to an ObjectId for the pipeline", async () => {
    mockAggregate.mockResolvedValue([{ data: [], count: [] }])
    await listInvites({ status: InviteStatus.PENDING, inviterId: INVITER as AccountId })

    const pipeline = mockAggregate.mock.calls[0][0]
    const match = pipeline[0].$match
    expect(match.status).toBe(InviteStatus.PENDING)
    // Aggregation pipelines bypass mongoose casting: a raw string would
    // silently match nothing against the ObjectId inviterId field.
    expect(typeof match.inviterId).toBe("object")
    expect(match.inviterId.toString()).toBe(INVITER)
  })
})
