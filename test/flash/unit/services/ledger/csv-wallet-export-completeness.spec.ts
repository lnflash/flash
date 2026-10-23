const getAccountTransactions = jest.fn()
jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    getAccountTransactions: (...args: unknown[]) => getAccountTransactions(...args),
  },
}))
jest.mock("@services/logger", () => ({
  baseLogger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}))

import { getTransactionsForWallets } from "@app/wallets/get-transactions-for-wallet"
import { IbexError } from "@services/ibex/errors"
import { CsvWalletsExport } from "@services/ledger/csv-wallet-export"

const wallets = [{ id: "owned-a" as WalletId }, { id: "owned-b" as WalletId }] as Wallet[]

beforeEach(() => {
  jest.clearAllMocks()
  getAccountTransactions.mockResolvedValue([])
})

it("keeps the existing ordinary-history partial behavior while export rejects a failed wallet", async () => {
  const providerError = new IbexError(new Error("private provider detail"))
  getAccountTransactions.mockImplementation(
    async ({ account_id }: { account_id: string }) =>
      account_id === "owned-b" ? providerError : [],
  )

  const ordinary = await getTransactionsForWallets({ wallets })
  expect(ordinary.error).toBeUndefined()
  expect(ordinary.result?.slice).toEqual([])

  const csv = new CsvWalletsExport()
  expect(await csv.addWallets(wallets)).toBe(providerError)
  expect(csv.entries).toEqual([])
  expect(getAccountTransactions).toHaveBeenCalledWith(
    expect.objectContaining({ account_id: "owned-a", page: 0, limit: 0 }),
  )
  expect(getAccountTransactions).toHaveBeenCalledWith(
    expect.objectContaining({ account_id: "owned-b", page: 0, limit: 0 }),
  )
})

it("preserves header-only output for an explicitly empty wallet set with no provider call", async () => {
  const csv = new CsvWalletsExport()
  expect(await csv.addWallets([])).toBeUndefined()
  expect(getAccountTransactions).not.toHaveBeenCalled()
  expect(Buffer.from(csv.getBase64(), "base64").toString("utf8")).toContain(" Wallet Id")
})

it("turns a thrown provider failure into a fixed export failure", async () => {
  getAccountTransactions.mockRejectedValue(new Error("private provider detail"))
  const csv = new CsvWalletsExport()

  const result = await csv.addWallets([wallets[0]])
  expect(result).toBeInstanceOf(Error)
  expect(result?.message).toBe("CSV export history unavailable")
  expect(csv.entries).toEqual([])
})

it("refuses an export if an unrepresentable provider row would be silently omitted", async () => {
  getAccountTransactions.mockResolvedValue([
    { id: "vendor-row", accountId: "owned-a", currencyId: 999 },
  ])
  const csv = new CsvWalletsExport()

  const result = await csv.addWallets([wallets[0]])
  expect(result).toBeInstanceOf(Error)
  expect(result?.message).toBe("CSV export has unrepresentable transactions")
  expect(csv.entries).toEqual([])
})
