const getCSVForAccount = jest.fn()
jest.mock("@app", () => ({
  Accounts: { getCSVForAccount: (...args: unknown[]) => getCSVForAccount(...args) },
}))
jest.mock("@graphql/error-map", () => ({ mapError: (error: Error) => error }))

import { InvalidWalletForAccountError } from "@domain/accounts"
import { exportOwnedAccountCSV } from "@graphql/public/types/object/csv-transactions"

const source = { id: "507f1f77bcf86cd799439011" } as Account
const owned = { id: source.id } as Account
const ids = ["owned-a" as WalletId]

beforeEach(() => {
  jest.clearAllMocks()
  getCSVForAccount.mockResolvedValue("aGVhZGVy")
})

it("passes the requested wallet set only for the authenticated source account", async () => {
  const result = await exportOwnedAccountCSV(source, ids, {
    domainAccount: owned,
  } as GraphQLPublicContextAuth)

  expect(result).toBe("aGVhZGVy")
  expect(getCSVForAccount).toHaveBeenCalledWith(source.id, ids)
})

it("rejects a foreign source before reading any wallet or export data", async () => {
  await expect(
    exportOwnedAccountCSV(source, ids, {
      domainAccount: { id: "foreign-account" },
    } as GraphQLPublicContextAuth),
  ).rejects.toBeInstanceOf(InvalidWalletForAccountError)
  expect(getCSVForAccount).not.toHaveBeenCalled()
})

it("maps an ownership or provider failure instead of coercing an error into a CSV string", async () => {
  getCSVForAccount.mockResolvedValue(new InvalidWalletForAccountError())
  await expect(
    exportOwnedAccountCSV(source, ids, {
      domainAccount: owned,
    } as GraphQLPublicContextAuth),
  ).rejects.toBeInstanceOf(InvalidWalletForAccountError)
})
