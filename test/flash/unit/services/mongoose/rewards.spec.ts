import { RewardAlreadyPresentError, UnknownRepositoryError } from "@domain/errors"
import { RewardsRepository } from "@services/mongoose/rewards"
import { Account } from "@services/mongoose/schema"

jest.mock("@services/mongoose/schema", () => ({
  Account: { findOneAndUpdate: jest.fn() },
}))
jest.mock("@services/mongoose/utils", () => ({ toObjectId: (id: string) => id }))

describe("RewardsRepository atomic claims", () => {
  const accountId = "account" as AccountId
  const lesson = "whatIsBitcoin" as QuizQuestionId
  let earned: QuizQuestionId[]

  beforeEach(() => {
    earned = []
    jest.mocked(Account.findOneAndUpdate).mockReset()
    // Model Mongo's atomic serialized write/preimage, applying the requested
    // operator rather than assuming the implementation already uses a set.
    jest.mocked(Account.findOneAndUpdate).mockImplementation((...args: unknown[]) => {
      const [, update] = args as [
        unknown,
        {
          $addToSet?: { earn: QuizQuestionId }
          $push?: { earn: QuizQuestionId }
        },
      ]
      const before = { earn: [...earned] }
      if (update.$push) earned.push(update.$push.earn)
      if (update.$addToSet && !earned.includes(update.$addToSet.earn))
        earned.push(update.$addToSet.earn)
      return Promise.resolve(before) as never
    })
  })

  it("allows exactly one concurrent claimant without appending duplicates", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => RewardsRepository(accountId).add(lesson)),
    )
    expect(results.filter((result) => result === true)).toHaveLength(1)
    expect(
      results.filter((result) => result instanceof RewardAlreadyPresentError),
    ).toHaveLength(11)
    expect(earned).toEqual([lesson])
    expect(Account.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: accountId },
      { $addToSet: { earn: lesson } },
      { new: false },
    )
  })

  it("preserves unrelated lessons and refuses a replay without another marker", async () => {
    earned = ["sat", lesson] as QuizQuestionId[]
    expect(await RewardsRepository(accountId).add(lesson)).toBeInstanceOf(
      RewardAlreadyPresentError,
    )
    expect(earned).toEqual(["sat", lesson])
  })

  it("does not rewrite historical duplicates", async () => {
    earned = [lesson, lesson]
    expect(await RewardsRepository(accountId).add(lesson)).toBeInstanceOf(
      RewardAlreadyPresentError,
    )
    expect(earned).toEqual([lesson, lesson])
  })

  it("preserves missing account and database failure errors", async () => {
    jest.mocked(Account.findOneAndUpdate).mockResolvedValueOnce(null)
    expect(await RewardsRepository(accountId).add(lesson)).toBeInstanceOf(
      UnknownRepositoryError,
    )
    jest.mocked(Account.findOneAndUpdate).mockRejectedValueOnce(new Error("offline"))
    expect(await RewardsRepository(accountId).add(lesson)).toBeInstanceOf(
      UnknownRepositoryError,
    )
  })
})
