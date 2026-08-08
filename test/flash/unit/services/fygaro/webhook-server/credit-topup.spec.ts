import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { WalletCurrency } from "@domain/shared"

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({
    findByRole: (...args: unknown[]) => mockFindByRole(...args),
  }),
  WalletsRepository: () => ({
    listByAccountId: (...args: unknown[]) => mockListByAccountId(...args),
  }),
}))

// credit-topup lazy-imports this module; jest's registry intercepts dynamic
// imports the same as static ones.
jest.mock("@app/payments/send-intraledger", () => ({
  intraledgerPaymentSendWalletIdForUsdWallet: (...args: unknown[]) =>
    mockIntraledgerSend(...args),
}))

const mockFindByRole = jest.fn()
const mockListByAccountId = jest.fn()
const mockIntraledgerSend = jest.fn()

import {
  creditFygaroTopup,
  FygaroCreditError,
} from "@services/fygaro/webhook-server/credit-topup"

const TREASURY_ACCOUNT_ID = "treasury-account" as AccountId
const RECIPIENT_ACCOUNT_ID = "recipient-account" as AccountId
const TX_ID = "0e2f2c1a-6f6e-4f2b-9b1e-3f1a2b3c4d5e"

const usdtWallet = (id: string) => ({ id, currency: WalletCurrency.Usdt })
const usdWallet = (id: string) => ({ id, currency: WalletCurrency.Usd })
const btcWallet = (id: string) => ({ id, currency: WalletCurrency.Btc })

// Wallet fixtures keyed by account: default = USDT treasury, USDT recipient.
const walletsByAccount: Record<string, unknown[]> = {}
const setWallets = (accountId: string, wallets: unknown[]) => {
  walletsByAccount[accountId] = wallets
}

const credit = (amountCents = 1000) =>
  creditFygaroTopup({
    recipientAccountId: RECIPIENT_ACCOUNT_ID,
    amountCents,
    transactionId: TX_ID,
  })

beforeEach(() => {
  jest.clearAllMocks()
  for (const key of Object.keys(walletsByAccount)) delete walletsByAccount[key]
  setWallets(TREASURY_ACCOUNT_ID, [btcWallet("t-btc"), usdtWallet("t-usdt")])
  setWallets(RECIPIENT_ACCOUNT_ID, [btcWallet("r-btc"), usdtWallet("r-usdt")])
  mockFindByRole.mockResolvedValue({ id: TREASURY_ACCOUNT_ID })
  mockListByAccountId.mockImplementation(async (accountId: string) => {
    return walletsByAccount[accountId] ?? []
  })
  mockIntraledgerSend.mockResolvedValue(PaymentSendStatus.Success)
})

describe("creditFygaroTopup", () => {
  it("sends the amount in cents from the treasury USDT wallet with the fygaro idempotency key", async () => {
    const result = await credit(1000)

    expect(mockFindByRole).toHaveBeenCalledWith("bankowner")
    expect(mockIntraledgerSend).toHaveBeenCalledWith({
      senderWalletId: "t-usdt",
      recipientWalletId: "r-usdt",
      amount: 1000,
      memo: `Card top-up (Fygaro ${TX_ID})`,
      idempotencyKey: `fygaro:${TX_ID}`,
    })
    expect(result).toEqual({ walletId: "r-usdt", status: "success" })
  })

  it("falls back to the legacy USD wallets when the treasury has no USDT wallet", async () => {
    setWallets(TREASURY_ACCOUNT_ID, [usdWallet("t-usd")])
    setWallets(RECIPIENT_ACCOUNT_ID, [usdWallet("r-usd"), usdtWallet("r-usdt")])

    const result = await credit()

    expect(mockIntraledgerSend).toHaveBeenCalledWith(
      expect.objectContaining({ senderWalletId: "t-usd", recipientWalletId: "r-usd" }),
    )
    expect(result).toEqual({ walletId: "r-usd", status: "success" })
  })

  it("treats a Pending send as credited and never retries", async () => {
    mockIntraledgerSend.mockResolvedValue(PaymentSendStatus.Pending)

    const result = await credit()

    expect(mockIntraledgerSend).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ walletId: "r-usdt", status: "pending" })
  })

  it.each([
    ["zero", 0],
    ["negative", -100],
    ["non-integer", 1000.5],
    ["NaN", NaN],
  ])("rejects a %s amount without touching any wallet", async (_label, amountCents) => {
    const result = await credit(amountCents)

    expect(result).toBeInstanceOf(FygaroCreditError)
    expect((result as FygaroCreditError).step).toBe("validate-amount")
    expect(mockFindByRole).not.toHaveBeenCalled()
    expect(mockIntraledgerSend).not.toHaveBeenCalled()
  })

  it("fails when no account holds the bankowner role", async () => {
    mockFindByRole.mockResolvedValue(new Error("CouldNotFindError"))

    const result = await credit()

    expect(result).toBeInstanceOf(FygaroCreditError)
    expect((result as FygaroCreditError).step).toBe("resolve-treasury")
    expect(mockIntraledgerSend).not.toHaveBeenCalled()
  })

  it("fails when the treasury has neither a USDT nor a USD wallet", async () => {
    setWallets(TREASURY_ACCOUNT_ID, [btcWallet("t-btc")])

    const result = await credit()

    expect(result).toBeInstanceOf(FygaroCreditError)
    expect((result as FygaroCreditError).step).toBe("resolve-treasury-wallet")
    expect(mockIntraledgerSend).not.toHaveBeenCalled()
  })

  it("fails when the recipient has no wallet in the funding currency", async () => {
    setWallets(RECIPIENT_ACCOUNT_ID, [usdWallet("r-usd")])

    const result = await credit()

    expect(result).toBeInstanceOf(FygaroCreditError)
    expect((result as FygaroCreditError).step).toBe("resolve-recipient-wallet")
    expect(mockIntraledgerSend).not.toHaveBeenCalled()
  })

  it("surfaces a send error as an intraledger-send failure", async () => {
    mockIntraledgerSend.mockResolvedValue(new Error("InsufficientBalanceError"))

    const result = await credit()

    expect(result).toBeInstanceOf(FygaroCreditError)
    expect((result as FygaroCreditError).step).toBe("intraledger-send")
  })

  it("fails on an unexpected payment status instead of assuming success", async () => {
    mockIntraledgerSend.mockResolvedValue(PaymentSendStatus.AlreadyPaid)

    const result = await credit()

    expect(result).toBeInstanceOf(FygaroCreditError)
    expect((result as FygaroCreditError).step).toBe("intraledger-send")
  })
})
