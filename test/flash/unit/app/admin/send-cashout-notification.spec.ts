
import { GaloyNotificationCategories } from "@domain/notifications"
import { sendCashoutNotification } from "@app/admin/send-cashout-notification"
import { NotificationsService } from "@services/notifications"
import { AccountsRepository, UsersRepository } from "@services/mongoose"
import { checkedToDeviceToken } from "@domain/users"

jest.mock("@services/notifications", () => ({
    NotificationsService: jest.fn(),
}))

jest.mock("@services/mongoose", () => ({
    AccountsRepository: jest.fn(),
    UsersRepository: jest.fn(),
}))

jest.mock("@domain/accounts", () => ({
    checkedToAccountUuid: (id: string) => id
}))

jest.mock("@domain/users", () => ({
    checkedToDeviceToken: (token: string) => token as DeviceToken
}))

describe("sendCashoutNotification", () => {
    const accountId = "account-id" as AccountUuid
    const title = "Test Title"
    const body = "Test Body"
    const amount = 100
    const currency = "USD"

    const mockAccount = {
        uuid: accountId,
        kratosUserId: "user-id",
        notificationSettings: {
            push: {
                enabled: true,
                disabledCategories: [],
            }
        }
    }

    const mockUser = {
        deviceTokens: ["override-token"] as DeviceToken[],
    }

    const adminPushNotificationFilteredSend = jest.fn().mockResolvedValue(true)

    beforeEach(() => {
        jest.clearAllMocks()
            ; (NotificationsService as jest.Mock).mockReturnValue({
                adminPushNotificationFilteredSend,
            })
            ; (AccountsRepository as jest.Mock).mockReturnValue({
                findByUuid: jest.fn().mockResolvedValue(mockAccount),
            })
            ; (UsersRepository as jest.Mock).mockReturnValue({
                findById: jest.fn().mockResolvedValue(mockUser),
            })
    })

    it("sends notification to user device tokens", async () => {
        const result = await sendCashoutNotification({
            accountId,
            title,
            body,
            amount,
            currency,
        })

        expect(result).toBe(true)
        expect(adminPushNotificationFilteredSend).toHaveBeenCalledWith({
            deviceTokens: mockUser.deviceTokens,
            title,
            body,
            data: { amount: "100", currency },
            notificationCategory: GaloyNotificationCategories.Payments,
            notificationSettings: mockAccount.notificationSettings,
        })
    })

    it("sends notification to provided device tokens override", async () => {
        const overrideTokens = ["override-token"] // paste given device token here
        const result = await sendCashoutNotification({
            accountId,
            title,
            body,
            amount,
            currency,
            deviceTokens: overrideTokens
        })

        expect(result).toBe(true)
        expect(adminPushNotificationFilteredSend).toHaveBeenCalledWith({
            deviceTokens: [checkedToDeviceToken(overrideTokens[0])],
            title,
            body,
            data: { amount: "100", currency },
            notificationCategory: GaloyNotificationCategories.Payments,
            notificationSettings: mockAccount.notificationSettings,
        })
        // Should NOT call UsersRepository if tokens are provided
        expect(UsersRepository).not.toHaveBeenCalled()
    })
})
