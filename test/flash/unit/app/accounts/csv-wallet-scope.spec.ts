const listByAccountId = jest.fn()
const addWallets = jest.fn()
const getBase64 = jest.fn()

jest.mock("@services/mongoose", () => ({
  WalletsRepository: () => ({ listByAccountId }),
}))
jest.mock("@services/ledger/csv-wallet-export", () => ({
  CsvWalletsExport: jest.fn().mockImplementation(() => ({ addWallets, getBase64 })),
}))

import { InvalidWalletForAccountError } from "@domain/accounts"
import { getCSVForAccount } from "@app/accounts/get-csv-for-account"

const account = "507f1f77bcf86cd799439011" as AccountId
const ownedA = { id: "owned-a", accountId: account } as Wallet
const ownedB = { id: "owned-b", accountId: account } as Wallet
const own = (id: string) => id as WalletId

beforeEach(() => {
  jest.clearAllMocks()
  listByAccountId.mockResolvedValue([ownedA, ownedB])
  addWallets.mockResolvedValue(undefined)
  getBase64.mockReturnValue("aGVhZGVy")
})

it("exports only the exact requested owned subset, in request order, without duplicate rows", async () => {
  const result = await getCSVForAccount(account, [
    own("owned-b"),
    own("owned-a"),
    own("owned-b"),
  ])

  expect(result).toBe("aGVhZGVy")
  expect(listByAccountId).toHaveBeenCalledWith(account)
  expect(addWallets).toHaveBeenCalledTimes(1)
  expect(addWallets).toHaveBeenCalledWith([ownedB, ownedA])
})

it("treats an empty required list as a header-only export, never all wallets", async () => {
  expect(await getCSVForAccount(account, [])).toBe("aGVhZGVy")
  expect(addWallets).toHaveBeenCalledWith([])
})

it.each(["foreign-wallet", "missing-wallet"])(
  "rejects %s identically before any CSV is built",
  async (id) => {
    const result = await getCSVForAccount(account, [own("owned-a"), own(id)])

    expect(result).toBeInstanceOf(InvalidWalletForAccountError)
    expect(addWallets).not.toHaveBeenCalled()
    expect(getBase64).not.toHaveBeenCalled()
  },
)

it("rejects a mismatched repository row instead of trusting its list membership", async () => {
  listByAccountId.mockResolvedValueOnce([
    ownedA,
    { id: "foreign-wallet", accountId: "foreign-account" },
  ])
  const result = await getCSVForAccount(account, [own("foreign-wallet")])

  expect(result).toBeInstanceOf(InvalidWalletForAccountError)
  expect(addWallets).not.toHaveBeenCalled()
})

it("rejects missing or malformed argument arrays rather than falling back to all wallets", async () => {
  for (const bad of [undefined, null, [new Error("invalid scalar")]]) {
    const result = await getCSVForAccount(account, bad as unknown as WalletId[])
    expect(result).toBeInstanceOf(InvalidWalletForAccountError)
  }
  expect(addWallets).not.toHaveBeenCalled()
})

it("propagates repository and export failures without returning an incomplete download", async () => {
  const repositoryError = new Error("repository unavailable")
  listByAccountId.mockResolvedValueOnce(repositoryError)
  expect(await getCSVForAccount(account, [own("owned-a")])).toBe(repositoryError)
  expect(addWallets).not.toHaveBeenCalled()

  const exportError = new Error("provider unavailable")
  addWallets.mockResolvedValueOnce(exportError)
  expect(await getCSVForAccount(account, [own("owned-a")])).toBe(exportError)
  expect(getBase64).not.toHaveBeenCalled()
})
