import { NotificationType } from "@domain/notifications"
import { WalletCurrency } from "@domain/shared"
import { createPushNotificationContent } from "@services/notifications/create-push-notification-content"

describe("createPushNotificationContent", () => {
  it("formats USDT invoice-paid notifications with USD-facing copy", () => {
    const content = createPushNotificationContent({
      type: NotificationType.LnInvoicePaid,
      userLanguage: "en" as UserLanguageOrEmpty,
      amount: {
        amount: 20_000n,
        currency: WalletCurrency.Usdt,
      } as PaymentAmount<typeof WalletCurrency.Usdt>,
    })

    expect(content).toEqual({
      title: "USD Transaction",
      body: "+0.02 USD",
    })
  })
})
