import { Admin } from "@app/index";
import AdminPushNotificationSendPayload from "@graphql/admin/types/payload/admin-push-notification-send";
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map";
import { GT } from "@graphql/index";
import { SUCCESS_RESPONSE } from "@graphql/shared/types/payload/success-payload";
import NotificationCategory from "@graphql/shared/types/scalar/notification-category";

const CashoutNotificationSendInput = GT.Input({
    name: "CashoutNotificationSendInput",
    fields: () => ({
        accountId: {
            type: GT.NonNull(GT.String),
        },
        amount: {
            type: GT.NonNull(GT.Float),
        },
        currency: {
            type: GT.NonNull(GT.String)
        },
        notificationCategory: {
            type: NotificationCategory,
        },
    })
})

const sendCashoutSettledNotification = GT.Field({
    extensions: {
        complexity: 1,
    },
    type: GT.NonNull(AdminPushNotificationSendPayload),
    args: {
        input: { type: GT.NonNull(CashoutNotificationSendInput) }
    },
    resolve: async (_, args) => {

        const { accountId, amount, currency, notificationCategory } = args.input;

        const title = "Cashout Successful"
        const body = `Your cashout of $${amount.toFixed(2)} ${currency} has been processed.`

        const success = await Admin.sendAdminPushNotification({
            accountId,
            title,
            body,
            data: { amount: String(amount), currency },
            notificationCategory
        })

        if (success instanceof Error) {
            return { errors: [mapAndParseErrorForGqlResponse(success)] }
        }

        return SUCCESS_RESPONSE

    }
})

export default sendCashoutSettledNotification