import { createCashWalletMigrationRuntimeServices } from "@app/cash-wallet-cutover/runtime-services"
import { InternalTransferMarkerError } from "@domain/payment-splits/errors"

const migration = {
  legacyUsdWalletId: "legacy-wallet-id" as WalletId,
  destinationUsdtWalletId: "destination-wallet-id" as WalletId,
} as CashWalletMigration

const rateLimitFetchError = () => new Error("FetchError: Too Many Requests")

describe("cutover runtime services — IBEX rate-limit retry (ENG-483)", () => {
  it("retries balance reads when the read REJECTS with a 429 FetchError", async () => {
    const sleeps: number[] = []
    const getRawAccountDetails = jest
      .fn()
      .mockRejectedValueOnce(rateLimitFetchError())
      .mockRejectedValueOnce(rateLimitFetchError())
      .mockResolvedValue({ balance: 12.5 })

    const services = createCashWalletMigrationRuntimeServices({
      getRawAccountDetails,
      rateLimitRetryDelayMs: 7,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })

    const result = await services.balanceReader.readSourceBalanceUsdCents(migration)

    expect(result).toBe("1250")
    expect(getRawAccountDetails).toHaveBeenCalledTimes(3)
    expect(sleeps).toEqual([7, 7])
  })

  it("retries on structural 429 (httpCode/status) with no rate-limit text (ENG-485)", async () => {
    const structural = Object.assign(new Error("Request failed"), { status: 429 })
    const getRawAccountDetails = jest
      .fn()
      .mockRejectedValueOnce(structural)
      .mockResolvedValue({ balance: 1 })

    const services = createCashWalletMigrationRuntimeServices({
      getRawAccountDetails,
      rateLimitRetryDelayMs: 1,
      sleep: async () => undefined,
    })

    const result = await services.balanceReader.readSourceBalanceUsdCents(migration)

    expect(result).toBe("100")
    expect(getRawAccountDetails).toHaveBeenCalledTimes(2)
  })

  it("retries balance reads when the read RETURNS a rate-limit error", async () => {
    const getRawAccountDetails = jest
      .fn()
      .mockResolvedValueOnce(new Error("Too Many Requests"))
      .mockResolvedValue({ balance: 3 })

    const services = createCashWalletMigrationRuntimeServices({
      getRawAccountDetails,
      rateLimitRetryDelayMs: 1,
      sleep: async () => undefined,
    })

    const result =
      await services.balanceReader.readDestinationBalanceUsdtMicros(migration)

    expect(result).toBe("3000000")
    expect(getRawAccountDetails).toHaveBeenCalledTimes(2)
  })

  it("gives up after maxAttempts and rethrows the final 429", async () => {
    const getRawAccountDetails = jest.fn().mockRejectedValue(rateLimitFetchError())

    const services = createCashWalletMigrationRuntimeServices({
      getRawAccountDetails,
      maxRateLimitAttempts: 3,
      rateLimitRetryDelayMs: 1,
      sleep: async () => undefined,
    })

    await expect(
      services.balanceReader.readSourceBalanceUsdCents(migration),
    ).rejects.toThrow("Too Many Requests")
    expect(getRawAccountDetails).toHaveBeenCalledTimes(3)
  })

  it("resolves the treasury to the funder's USDT wallet regardless of its default (ENG-482)", async () => {
    const walletsRepo = {
      findById: jest.fn().mockResolvedValue({
        id: "funder-btc-wallet" as WalletId,
        accountId: "funder-account" as AccountId,
        currency: "BTC",
      }),
      listByAccountId: jest.fn().mockResolvedValue([
        { id: "funder-btc-wallet", currency: "BTC" },
        { id: "funder-usdt-wallet", currency: "USDT" },
      ]),
    }

    const services = createCashWalletMigrationRuntimeServices({
      walletsRepo: walletsRepo as never,
      getFunderWalletId: async () => "funder-btc-wallet" as WalletId,
    })

    await expect(services.treasuryService.getTreasuryWalletId()).resolves.toBe(
      "funder-usdt-wallet",
    )
  })

  it("short-circuits when the funder default is already the USDT wallet", async () => {
    const walletsRepo = {
      findById: jest.fn().mockResolvedValue({
        id: "funder-usdt-wallet" as WalletId,
        accountId: "funder-account" as AccountId,
        currency: "USDT",
      }),
      listByAccountId: jest.fn(),
    }

    const services = createCashWalletMigrationRuntimeServices({
      walletsRepo: walletsRepo as never,
      getFunderWalletId: async () => "funder-usdt-wallet" as WalletId,
    })

    await expect(services.treasuryService.getTreasuryWalletId()).resolves.toBe(
      "funder-usdt-wallet",
    )
    expect(walletsRepo.listByAccountId).not.toHaveBeenCalled()
  })

  it("memoizes treasury resolution — one lookup for the whole run", async () => {
    const walletsRepo = {
      findById: jest.fn().mockResolvedValue({
        id: "funder-usdt-wallet" as WalletId,
        accountId: "funder-account" as AccountId,
        currency: "USDT",
      }),
      listByAccountId: jest.fn(),
    }

    const services = createCashWalletMigrationRuntimeServices({
      walletsRepo: walletsRepo as never,
      getFunderWalletId: async () => "funder-usdt-wallet" as WalletId,
    })

    await services.treasuryService.getTreasuryWalletId()
    await services.treasuryService.getTreasuryWalletId()
    await services.treasuryService.getTreasuryWalletId()

    expect(walletsRepo.findById).toHaveBeenCalledTimes(1)
  })

  it("fails closed when the funder has duplicate USDT wallets", async () => {
    const walletsRepo = {
      findById: jest.fn().mockResolvedValue({
        id: "funder-btc-wallet" as WalletId,
        accountId: "funder-account" as AccountId,
        currency: "BTC",
      }),
      listByAccountId: jest.fn().mockResolvedValue([
        { id: "usdt-1", currency: "USDT" },
        { id: "usdt-2", currency: "USDT" },
      ]),
    }

    const services = createCashWalletMigrationRuntimeServices({
      walletsRepo: walletsRepo as never,
      getFunderWalletId: async () => "funder-btc-wallet" as WalletId,
    })

    const result = await services.treasuryService.getTreasuryWalletId()
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch(/2 USDT wallets/)
  })

  it("returns a descriptive error when the funder has no USDT wallet", async () => {
    const walletsRepo = {
      findById: jest.fn().mockResolvedValue({
        id: "funder-btc-wallet" as WalletId,
        accountId: "funder-account" as AccountId,
        currency: "BTC",
      }),
      listByAccountId: jest
        .fn()
        .mockResolvedValue([{ id: "funder-btc-wallet", currency: "BTC" }]),
    }

    const services = createCashWalletMigrationRuntimeServices({
      walletsRepo: walletsRepo as never,
      getFunderWalletId: async () => "funder-btc-wallet" as WalletId,
    })

    const result = await services.treasuryService.getTreasuryWalletId()
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch(/no USDT wallet/)
  })

  it("does not retry non-rate-limit rejections", async () => {
    const getRawAccountDetails = jest
      .fn()
      .mockRejectedValue(new Error("FetchError: Not Found"))

    const services = createCashWalletMigrationRuntimeServices({
      getRawAccountDetails,
      rateLimitRetryDelayMs: 1,
      sleep: async () => undefined,
    })

    await expect(
      services.balanceVerifier.verifyBalanceMove({
        legacyUsdWalletId: migration.legacyUsdWalletId,
      }),
    ).rejects.toThrow("Not Found")
    expect(getRawAccountDetails).toHaveBeenCalledTimes(1)
  })
})

describe("cutover runtime services — internal-transfer marker (ENG-653)", () => {
  // Every cutover invoice is paid by Flash itself; its receive must never
  // trigger the recipient's payment splits.
  const bolt11 =
    "lnbc140n1p3k6yzupp53p305l6de6s9xw2j0qaa59pl7lahys4f2uavwncll9z2vq0syvvsdqqcqzpgxqzuysp5mdgsaa734eg7srwx92rsn3hyc4xzt5tphfpadl5c6fanhppwaz4s9qyyssqm6yhnnhl8jltwjtclzk4g7nxr99ycsp4sqd6vksevqh06h8l3gm5fdhtl59t6g3fsalv26sj5zvwhxwlghc9wcfgkrjrtuh4873ejnspc5xksy"
  const paymentHash = "8862fa7f4dcea0533952783bda143ff7fb7242a9573ac74f1ff944a601f02319"
  const recipientWalletId = "destination-wallet-id" as WalletId

  it.each([
    ["createInvoice", { recipientWalletId, amount: "1000000", memo: "cutover" }],
    ["createNoAmountInvoice", { recipientWalletId, memo: "cutover" }],
  ] as const)("%s records the invoice hash with origin cutover", async (method, args) => {
    const recordInternalTransferInvoice = jest.fn().mockResolvedValue(true)
    const addInvoice = jest.fn().mockResolvedValue({ invoice: { bolt11 } })
    const services = createCashWalletMigrationRuntimeServices({
      createInvoice: addInvoice,
      createNoAmountInvoice: addInvoice,
      recordInternalTransferInvoice,
    })

    const invoice = await (
      services.invoiceService[method] as (a: typeof args) => Promise<unknown>
    )(args)

    expect(invoice).not.toBeInstanceOf(Error)
    expect((invoice as LnInvoice).paymentHash).toBe(paymentHash)
    expect(recordInternalTransferInvoice).toHaveBeenCalledWith({
      paymentHash,
      recipientWalletId,
      origin: "cutover",
    })
  })

  it("does not hand back an invoice to pay when the marker write fails", async () => {
    const services = createCashWalletMigrationRuntimeServices({
      createNoAmountInvoice: jest.fn().mockResolvedValue({ invoice: { bolt11 } }),
      recordInternalTransferInvoice: jest.fn().mockResolvedValue(new Error("mongo down")),
    })

    const invoice = await services.invoiceService.createNoAmountInvoice({
      recipientWalletId,
      memo: "cutover",
    })

    expect(invoice).toBeInstanceOf(InternalTransferMarkerError)
  })
})
