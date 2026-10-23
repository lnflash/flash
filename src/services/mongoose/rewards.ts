import { RewardAlreadyPresentError, UnknownRepositoryError } from "@domain/errors"

import { Account } from "./schema"

import { toObjectId } from "./utils"

// FIXME: improve boundary
export const RewardsRepository = (accountId: AccountId) => {
  const add = async (quizQuestionId: QuizQuestionId) => {
    try {
      // The update and its preimage are atomic: only the first claimant sees
      // the lesson absent. Replays must not append another completion marker.
      const oldState = await Account.findOneAndUpdate(
        { _id: toObjectId<AccountId>(accountId) },
        { $addToSet: { earn: quizQuestionId } },
        { new: false },
      )

      if (!oldState) {
        return new UnknownRepositoryError("account not found")
      }

      const rewardNotFound =
        oldState.earn.findIndex((item) => item === quizQuestionId) === -1

      return rewardNotFound || new RewardAlreadyPresentError()
    } catch (err) {
      return new UnknownRepositoryError("reward issue")
    }
  }

  return {
    add,
  }
}
