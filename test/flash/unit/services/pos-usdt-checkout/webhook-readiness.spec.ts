import { flashUsdtCheckout } from "@services/pos-usdt-checkout/flash"

jest.mock("@services/ibex/hub-public-key", () => ({ hubPublicKey: undefined }))

it("declines new sales when incoming deposit notifications cannot be verified", async () => {
  const old = process.env
  process.env = { ...old, POS_USDT_CHECKOUT_ENABLED: "true", POS_USDT_MIN_LEVEL: "1" }
  try {
    const service = flashUsdtCheckout()
    expect(service).toBeTruthy()
    const recipientWalletId = "4406456f-69d7-4481-97e4-beadabc45678"
    expect(await service!.supports(recipientWalletId)).toBe(false)
    await expect(
      service!.create(
        { recipientWalletId, amountMinor: 125, requestId: "d".repeat(64) },
        "127.0.0.1",
      ),
    ).rejects.toThrow("unavailable")
  } finally {
    process.env = old
  }
})
