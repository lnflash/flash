import { DuplicateKeyForPersistError, UnknownRepositoryError } from "@domain/errors"
import { parseRepositoryError } from "@services/mongoose/utils"

describe("parseRepositoryError", () => {
  // The driver message is the only thing that names the collection and index
  // that collided. Dropping it left 26 failed registration writes on
  // 2026-09-01 unattributable between accounts.kratosUserId and users.phone.
  it("keeps the driver message on a duplicate key error", () => {
    const driverMessage =
      'E11000 duplicate key error collection: galoy.users index: phone_1 dup key: { phone: "+2348012345678" }'

    const result = parseRepositoryError(new Error(driverMessage))

    expect(result).toBeInstanceOf(DuplicateKeyForPersistError)
    expect(result.message).toContain("galoy.users index: phone_1")
  })

  it("still falls through to the unknown repository error otherwise", () => {
    const result = parseRepositoryError(new Error("something else entirely"))

    expect(result).toBeInstanceOf(UnknownRepositoryError)
  })
})
