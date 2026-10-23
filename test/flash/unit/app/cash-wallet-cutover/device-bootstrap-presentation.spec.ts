const mockControlled = jest.fn(),
  mockPersist = jest.fn(),
  mockUpdate = jest.fn(),
  mockLock = jest.fn()
jest.mock("@services/mongoose/device-bootstrap", () => ({
  hasControlledDeviceBootstrap: (...args: unknown[]) => mockControlled(...args),
}))
jest.mock("@services/mongoose", () => ({
  WalletsRepository: () => ({ persistNew: (...args: unknown[]) => mockPersist(...args) }),
  CashWalletCutoverRepository: () => ({}),
}))
jest.mock("@services/lock", () => ({
  LockService: () => ({ lockAccountId: (...args: unknown[]) => mockLock(...args) }),
}))
jest.mock("@services/tracing", () => ({ recordExceptionInCurrentSpan: jest.fn() }))
jest.mock("@app/accounts/update-default-walletid", () => ({
  updateDefaultWalletId: (...args: unknown[]) => mockUpdate(...args),
}))

import { resolveCashWalletPresentationForAccount } from "@app/cash-wallet-cutover/presentation-for-account"
import { CashWalletMissingUsdtWalletError } from "@app/cash-wallet-cutover/errors"
import { USDAmount, WalletCurrency } from "@domain/shared"

const account = (level: number) =>
  ({ id: "account-owned", level, defaultWalletId: "usd-owned" }) as Account
const usd = { id: "usd-owned", currency: WalletCurrency.Usd } as Wallet
const usdt = { id: "usdt-created", currency: WalletCurrency.Usdt } as Wallet
const migrationsRepo = {
  getConfig: async () =>
    ({ state: "complete", cutoverVersion: 1, runId: "run" }) as CashWalletCutoverConfig,
  findMigrationByAccountId: async () => null,
}
const client = { cashWalletPresentation: "usdt" as const, hasUsdtCashWalletSupport: true }
const read = (level: number) =>
  resolveCashWalletPresentationForAccount({
    account: account(level),
    client,
    migrationsRepo,
    walletsRepo: {
      listByAccountId: async () => [usd],
      persistNew: (...args) => mockPersist(...args),
    },
    legacyUsdBalance: async () => ({ isZero: () => true }) as USDAmount,
  })
beforeEach(() => {
  jest.clearAllMocks()
  mockControlled.mockResolvedValue(true)
  mockLock.mockImplementation(
    async (_id: string, work: (signal: { aborted: boolean }) => Promise<unknown>) =>
      work({ aborted: false }),
  )
  mockPersist.mockResolvedValue(usdt)
})

it.each([0, 1, 3])(
  "public presentation cannot re-create controlled missing USDT after level%s or schema upgrade",
  async (level) => {
    const result = await read(level)
    expect(result).toBeInstanceOf(CashWalletMissingUsdtWalletError)
    expect(mockControlled).toHaveBeenCalledWith("account-owned")
    expect(mockPersist).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockLock).toHaveBeenCalledTimes(1)
  },
)

it("retains ordinary noncontrolled phone-account convergence semantics", async () => {
  mockControlled.mockResolvedValue(false)
  const result = await read(1)
  expect(result).not.toBeInstanceOf(Error)
  expect(mockPersist).toHaveBeenCalledTimes(1)
  expect(mockUpdate).toHaveBeenCalledWith({
    accountId: "account-owned",
    walletId: "usdt-created",
  })
})

it("does not treat journal-storage failure as permission to make a public provider call", async () => {
  mockControlled.mockRejectedValue(new Error("Storage unavailable"))
  expect(await read(1)).toBeInstanceOf(CashWalletMissingUsdtWalletError)
  expect(mockPersist).not.toHaveBeenCalled()
})
