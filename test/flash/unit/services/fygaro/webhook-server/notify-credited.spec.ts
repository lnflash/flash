const mockFindById = jest.fn()
const mockIntraLedgerTxReceived = jest.fn()
const mockRemoveDeviceTokens = jest.fn()

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

// All three are lazy-imported by the module under test (the webhook server is
// its own process and `@services/notifications` pulls in Firebase + redis
// pubsub at module load). Jest's registry intercepts dynamic imports the same
// as static ones.
jest.mock("@services/mongoose", () => ({
  UsersRepository: () => ({
    findById: (...args: unknown[]) => mockFindById(...args),
  }),
}))

jest.mock("@services/notifications", () => ({
  NotificationsService: () => ({
    intraLedgerTxReceived: (...args: unknown[]) => mockIntraLedgerTxReceived(...args),
  }),
}))

jest.mock("@app/users/remove-device-tokens", () => ({
  removeDeviceTokens: (...args: unknown[]) => mockRemoveDeviceTokens(...args),
}))

import { DeviceTokensNotRegisteredNotificationsServiceError } from "@domain/notifications"
import { WalletCurrency } from "@domain/shared"
import { notifyFygaroTopupCredited } from "@services/fygaro/webhook-server/notify-credited"

const ACCOUNT_ID = "account-1" as AccountId
const USER_ID = "kratos-user-1" as UserId
const WALLET_ID = "wallet-1" as WalletId
const TX_ID = "0e2f2c1a-6f6e-4f2b-9b1e-3f1a2b3c4d5e"

const NOTIFICATION_SETTINGS = { push: { enabled: true, disabledCategories: [] } }

const ACCOUNT = {
  id: ACCOUNT_ID,
  kratosUserId: USER_ID,
  notificationSettings: NOTIFICATION_SETTINGS,
} as unknown as Account

const USER = {
  id: USER_ID,
  deviceTokens: ["token-a"],
  language: "en",
}

const notify = (
  overrides: Partial<{
    recipientWalletCurrency: WalletCurrency
    netAmountCents: number
  }> = {},
) =>
  notifyFygaroTopupCredited({
    recipientAccount: ACCOUNT,
    recipientWalletId: WALLET_ID,
    recipientWalletCurrency: WalletCurrency.Usdt,
    netAmountCents: 901,
    transactionId: TX_ID,
    ...overrides,
  })

beforeEach(() => {
  jest.clearAllMocks()
  mockFindById.mockResolvedValue(USER)
  mockIntraLedgerTxReceived.mockResolvedValue(true)
  mockRemoveDeviceTokens.mockResolvedValue(USER)
})

describe("notifyFygaroTopupCredited", () => {
  it("pushes the credit to the recipient's own devices, honouring their settings", async () => {
    await notify()

    expect(mockFindById).toHaveBeenCalledWith(USER_ID)
    expect(mockIntraLedgerTxReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientAccountId: ACCOUNT_ID,
        recipientWalletId: WALLET_ID,
        recipientDeviceTokens: ["token-a"],
        recipientNotificationSettings: NOTIFICATION_SETTINGS,
        recipientLanguage: "en",
      }),
    )
  })

  it("scales the net into the credited wallet's own minor unit", async () => {
    // THE trap. The amount handed to the send is USD CENTS whatever the wallet
    // — `intraledgerPaymentSendWalletIdForUsdWallet` formats it with
    // `usdCentsDisplay` — but `createPushNotificationContent` divides by
    // 1,000,000 for USDT and by 100 for USD. Passing 901 with currency USDT
    // announces "$0.0009" for a $9.01 credit on every post-cutover account.
    await notify({ recipientWalletCurrency: WalletCurrency.Usdt })

    expect(mockIntraLedgerTxReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentAmount: { amount: 9_010_000n, currency: WalletCurrency.Usdt },
      }),
    )
  })

  it("leaves a legacy USD wallet's amount in cents", async () => {
    await notify({ recipientWalletCurrency: WalletCurrency.Usd })

    expect(mockIntraLedgerTxReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentAmount: { amount: 901n, currency: WalletCurrency.Usd },
      }),
    )
  })

  it("cleans up device tokens Firebase has rejected", async () => {
    // Same treatment every other receive path gives them (send-lightning.ts,
    // add-settled-on-chain-transaction.ts): a dead token left on the user makes
    // every future push report a failure.
    mockIntraLedgerTxReceived.mockResolvedValue(
      new DeviceTokensNotRegisteredNotificationsServiceError(["token-a" as DeviceToken]),
    )

    await notify()

    expect(mockRemoveDeviceTokens).toHaveBeenCalledWith({
      userId: USER_ID,
      deviceTokens: ["token-a"],
    })
  })

  it("never throws when the user cannot be read", async () => {
    // It runs AFTER the money moved and after the audit row was promoted. A
    // throw here becomes a 500 that asks Fygaro to retry a payment already
    // sitting in the customer's wallet.
    mockFindById.mockResolvedValue(new Error("CouldNotFindError"))

    await expect(notify()).resolves.toBeUndefined()
    expect(mockIntraLedgerTxReceived).not.toHaveBeenCalled()
  })

  it("never throws when the notification service itself blows up", async () => {
    mockIntraLedgerTxReceived.mockRejectedValue(new Error("firebase down"))

    await expect(notify()).resolves.toBeUndefined()
  })

  it("never throws when the push is merely refused", async () => {
    mockIntraLedgerTxReceived.mockResolvedValue(new Error("NotificationsServiceError"))

    await expect(notify()).resolves.toBeUndefined()
  })
})
