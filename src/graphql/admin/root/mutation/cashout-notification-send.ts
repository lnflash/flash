import { Admin } from "@app/index";
import { apolloErrorResponse, mapAndParseErrorForGqlResponse } from "@graphql/error-map";
import { GT } from "@graphql/index";
import SuccessPayload, { SUCCESS_RESPONSE } from "@graphql/shared/types/payload/success-payload";
import { checkedToAccountUuid } from "@domain/accounts";
import { toMoneyAmount } from "@domain/shared";
import { InputValidationError } from "@graphql/error";


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
        }
    })
})

const sendCashoutSettledNotification = GT.Field({
    extensions: {
        complexity: 1,
    },
    type: GT.NonNull(SuccessPayload),
    args: {
        input: { type: GT.NonNull(CashoutNotificationSendInput) }
    },
    resolve: async (_, args) => {
        const { accountId, amount, currency } = args.input;

        const checkedAccountId = checkedToAccountUuid(accountId)
        if (checkedAccountId instanceof Error) return apolloErrorResponse(new InputValidationError({ message: "Invalid accountId" }))

        const checkedAmount = toMoneyAmount(amount, currency)
        if (checkedAmount instanceof Error) return apolloErrorResponse(new InputValidationError({ message: "Invalid amount" }))

        const success = await Admin.sendCashoutNotification(checkedAccountId, checkedAmount)
        if (success instanceof Error) {
            return { errors: [mapAndParseErrorForGqlResponse(success)] }
        }

        return SUCCESS_RESPONSE
    }
})

export default sendCashoutSettledNotification