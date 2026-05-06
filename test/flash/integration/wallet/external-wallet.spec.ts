import { alice, bob } from "../jest.setup"
import { WalletsRepository } from "@services/mongoose"
import { InvalidLnurlError } from "@domain/errors"
import { CouldNotFindWalletFromIdError } from "@domain/errors"

const VALID_LNURL = "LNURL1DP68GURN8GHJ7MRWW4EXCTNZD9NHXATW9EU8J730D3H82UNV94MKJ4RF9DZ"
const UPDATED_LNURL = "lnurl1dp68gurn8ghj7mrww4exctnzd9nhxatw9eu8j730d3h82unv94mkj4rf9dz99"

afterEach(() => jest.clearAllMocks())

describe("WalletsRepository.upsertExternal", () => {
  it("creates an external wallet with a valid lnurl", async () => {
    const result = await WalletsRepository().upsertExternal({
      accountId: alice.account.id,
      lnurlp: VALID_LNURL as Lnurl,
    })
    if (result instanceof Error) throw result

    expect(result.type).toBe("external")
    expect(result.lnurlp).toBe(VALID_LNURL)
    expect(result.accountId).toBe(alice.account.id)
    expect(result.id).toBeTruthy()
  })

  it("updates lnurlp on a second call for the same account (upsert)", async () => {
    await WalletsRepository().upsertExternal({
      accountId: alice.account.id,
      lnurlp: VALID_LNURL as Lnurl,
    })

    const updated = await WalletsRepository().upsertExternal({
      accountId: alice.account.id,
      lnurlp: UPDATED_LNURL as Lnurl,
    })
    if (updated instanceof Error) throw updated

    expect(updated.lnurlp).toBe(UPDATED_LNURL)
    expect(updated.type).toBe("external")
  })

  it("preserves the wallet id across updates", async () => {
    const first = await WalletsRepository().upsertExternal({
      accountId: bob.account.id,
      lnurlp: VALID_LNURL as Lnurl,
    })
    if (first instanceof Error) throw first

    const second = await WalletsRepository().upsertExternal({
      accountId: bob.account.id,
      lnurlp: UPDATED_LNURL as Lnurl,
    })
    if (second instanceof Error) throw second

    expect(second.id).toBe(first.id)
  })

  it("returns InvalidLnurlError for a string that does not start with lnurl1", async () => {
    const result = await WalletsRepository().upsertExternal({
      accountId: alice.account.id,
      lnurlp: "https://example.com/.well-known/lnurlp/alice" as Lnurl,
    })
    expect(result).toBeInstanceOf(InvalidLnurlError)
  })

  it("returns InvalidLnurlError for an empty string", async () => {
    const result = await WalletsRepository().upsertExternal({
      accountId: alice.account.id,
      lnurlp: "" as Lnurl,
    })
    expect(result).toBeInstanceOf(InvalidLnurlError)
  })
})

describe("WalletsRepository.findExternalByAccountId", () => {
  it("finds the external wallet after upsert", async () => {
    await WalletsRepository().upsertExternal({
      accountId: alice.account.id,
      lnurlp: VALID_LNURL as Lnurl,
    })

    const result = await WalletsRepository().findExternalByAccountId(alice.account.id)
    if (result instanceof Error) throw result

    expect(result.type).toBe("external")
    expect(result.accountId).toBe(alice.account.id)
  })

  it("returns CouldNotFindWalletFromIdError when no external wallet exists for the account", async () => {
    // Use a fresh account that has never had an external wallet
    const result = await WalletsRepository().findExternalByAccountId(
      "00000000-0000-0000-0000-000000000000" as AccountId,
    )
    expect(result).toBeInstanceOf(CouldNotFindWalletFromIdError)
  })
})
