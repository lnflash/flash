import { sendCashoutNotification } from "@app/admin/send-cashout-notification"
import { AccountsRepository } from "@services/mongoose/accounts"
import { UsersRepository } from "@services/mongoose/users"
import { PushNotificationsService } from "@services/notifications/push-notifications"
import { getI18nInstance } from "@config"

jest.mock("@services/mongoose/accounts", () => ({
    AccountsRepository: jest.fn(),
}))

jest.mock("@services/mongoose/users", () => ({
    UsersRepository: jest.fn(),
}))

jest.mock("@services/notifications/push-notifications", () => ({
    PushNotificationsService: jest.fn(),
}))

jest.mock("@config", () => {
    const mockI18n = {
        __: jest.fn().mockImplementation(({ phrase }, options) => `${phrase} ${JSON.stringify(options)}`),
    }
    return {
        getI18nInstance: jest.fn(() => mockI18n),
    }
})

describe("sendCashoutNotification", () => {
    const accountId = "account-id" as AccountUuid
    const amount = { 
        currencyCode: "USD", 
        i18n: () => "1.00 USD", 
        toString: () => "100" 
    } as any // MoneyAmount

    const mockAccount = {
        uuid: accountId,
        kratosUserId: "user-id",
    }

    const mockUser = {
        deviceTokens: ["token-1", "token-2"],
    }

    const sendNotification = jest.fn().mockReturnValue(true)
    const mockI18n = getI18nInstance()

    beforeEach(() => {
        jest.clearAllMocks()
        ; (AccountsRepository as jest.Mock).mockReturnValue({
            findByUuid: jest.fn().mockResolvedValue(mockAccount),
        })
        ; (UsersRepository as jest.Mock).mockReturnValue({
            findById: jest.fn().mockResolvedValue(mockUser),
        })
        ; (PushNotificationsService as jest.Mock).mockReturnValue({
            sendNotification,
        })
        ; (getI18nInstance as jest.Mock).mockReturnValue(mockI18n)
    })

    it("sends notification to user device tokens", async () => {
        const result = await sendCashoutNotification(accountId, amount)

        expect(result).toBe(true)
        expect(sendNotification).toHaveBeenCalledWith({
            deviceTokens: mockUser.deviceTokens,
            title: mockI18n.__({ phrase: "notification.cashout.title", locale: "en" }, { currency: amount.currencyCode }),
            body: mockI18n.__({ phrase: "notification.cashout.body", locale: "en" }, { amount: amount.i18n() }),
            data: { amount: String(amount), currency: amount.currencyCode },
        })
    })

    it("returns error if account is not found", async () => {
        const error = new Error("Account not found")
        ; (AccountsRepository as jest.Mock).mockReturnValue({
            findByUuid: jest.fn().mockResolvedValue(error),
        })

        const result = await sendCashoutNotification(accountId, amount)

        expect(result).toBe(error)
        expect(sendNotification).not.toHaveBeenCalled()
    })

    it("returns error if user is not found", async () => {
        const error = new Error("User not found")
        ; (UsersRepository as jest.Mock).mockReturnValue({
            findById: jest.fn().mockResolvedValue(error),
        })

        const result = await sendCashoutNotification(accountId, amount)

        expect(result).toBe(error)
        expect(sendNotification).not.toHaveBeenCalled()
    })
})
