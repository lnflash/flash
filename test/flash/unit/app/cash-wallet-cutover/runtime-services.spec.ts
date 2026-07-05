import { createCashWalletMigrationRuntimeServices } from "@app/cash-wallet-cutover/runtime-services"

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
