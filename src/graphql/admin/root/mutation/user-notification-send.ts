import { Admin } from "@app/index"
import { checkedToAccountUuid } from "@domain/accounts"
import {
  AllDeviceTokensStaleNotificationsServiceError,
  InvalidDeviceNotificationsServiceError,
  NoDeviceAcceptedPushNotificationsServiceError,
  RecipientDisabledNotificationsServiceError,
} from "@domain/notifications"
import { ValidationError } from "@domain/shared"
import { InputValidationError, PushNotificationError } from "@graphql/error"
import { apolloErrorResponse, mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { GT } from "@graphql/index"
import SuccessPayload, {
  SUCCESS_RESPONSE,
} from "@graphql/shared/types/payload/success-payload"

const MAX_TITLE_LENGTH = 256
const MAX_BODY_LENGTH = 1024

// PushNotificationError defaults to code "FIREBASE_ERROR", which would collapse
// four distinct terminal states into one. Callers (the ERPNext support panel,
// alerting) must be able to tell "the user opted out" — normal, ignore — from
// "push infrastructure is down" — page engineering — without regexing English
// prose that a copy edit silently breaks.
const PushErrorCode = {
  AllTokensStale: "PUSH_ALL_TOKENS_STALE",
  NoDeviceAccepted: "PUSH_NO_DEVICE_ACCEPTED",
  RecipientDisabled: "PUSH_RECIPIENT_DISABLED",
  NoDeviceTokens: "PUSH_NO_DEVICE_TOKENS",
} as const

// apolloErrorResponse omits the `success` key (it would read as null);
// make every error branch of this mutation report an explicit success: false
const failureResponse = (e: Parameters<typeof apolloErrorResponse>[0]) => ({
  ...apolloErrorResponse(e),
  success: false,
})

const UserNotificationSendInput = GT.Input({
  name: "UserNotificationSendInput",
  description:
    "Sends a push notification to one user's registered devices. " +
    "Honors the recipient's notification settings: a user who has disabled " +
    "push, or the AdminPushNotification category, is not sent to and the " +
    "mutation returns success: false with 'User has disabled admin " +
    "notifications' — a normal terminal state, not a system failure. " +
    "Other reachable terminal states: the user has no registered devices, " +
    "every registered device token is stale (app uninstalled/reinstalled), " +
    "and no device accepted the push (push infrastructure problem — escalate " +
    "to engineering rather than to the user).",
  fields: () => ({
    accountId: {
      type: GT.String,
      description: "Account uuid of the recipient. Provide this or username.",
    },
    username: {
      type: GT.String,
      description: "Username of the recipient. Provide this or accountId.",
    },
    title: {
      type: GT.NonNull(GT.String),
      description: `Notification title. Trimmed; 1 to ${MAX_TITLE_LENGTH} characters.`,
    },
    body: {
      type: GT.NonNull(GT.String),
      description: `Notification body. Trimmed; 1 to ${MAX_BODY_LENGTH} characters.`,
    },
  }),
})

const UserNotificationSendMutation = GT.Field<
  null,
  GraphQLAdminContext,
  {
    input: {
      accountId?: string
      username?: string
      title: string
      body: string
    }
  }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(SuccessPayload),
  args: {
    input: { type: GT.NonNull(UserNotificationSendInput) },
  },
  resolve: async (_, args, ctx) => {
    const { accountId, username, title, body } = args.input
    // Threaded into the app layer, which logs it: this is the only record of
    // the operator behind an arbitrary push to a named user.
    const sentBy = ctx.user.id

    if (!accountId === !username)
      return failureResponse(
        new InputValidationError({
          message: "Exactly one of accountId or username is required",
        }),
      )

    const trimmedTitle = title.trim()
    if (trimmedTitle.length === 0 || trimmedTitle.length > MAX_TITLE_LENGTH)
      return failureResponse(
        new InputValidationError({
          message: `Title must be between 1 and ${MAX_TITLE_LENGTH} characters`,
        }),
      )

    const trimmedBody = body.trim()
    if (trimmedBody.length === 0 || trimmedBody.length > MAX_BODY_LENGTH)
      return failureResponse(
        new InputValidationError({
          message: `Body must be between 1 and ${MAX_BODY_LENGTH} characters`,
        }),
      )

    let checkedAccountId: AccountUuid
    if (accountId) {
      const checked = checkedToAccountUuid(accountId)
      if (checked instanceof Error)
        return failureResponse(new InputValidationError({ message: "Invalid accountId" }))
      checkedAccountId = checked
    } else {
      // getAccountByUsername validates the username format itself, but
      // UsernameRegex rejects surrounding whitespace — trim so a username
      // pasted out of a support ticket resolves instead of reading as invalid.
      const account = await Admin.getAccountByUsername((username as string).trim())
      if (account instanceof ValidationError)
        return failureResponse(new InputValidationError({ message: "Invalid username" }))
      if (account instanceof Error) {
        return { errors: [mapAndParseErrorForGqlResponse(account)], success: false }
      }
      checkedAccountId = account.uuid
    }

    const result = await Admin.sendUserNotification({
      accountId: checkedAccountId,
      title: trimmedTitle,
      body: trimmedBody,
      sentBy,
    })
    if (result instanceof AllDeviceTokensStaleNotificationsServiceError)
      return failureResponse(
        new PushNotificationError({
          code: PushErrorCode.AllTokensStale,
          message:
            "All of the user's registered devices are stale (app uninstalled or reinstalled). Tokens were cleared; ask them to reopen the app.",
        }),
      )
    if (result instanceof NoDeviceAcceptedPushNotificationsServiceError)
      return failureResponse(
        new PushNotificationError({
          code: PushErrorCode.NoDeviceAccepted,
          message:
            "Delivery failed for reasons other than stale tokens — check push infrastructure, not the user. Escalate to engineering rather than retrying.",
        }),
      )
    if (result instanceof RecipientDisabledNotificationsServiceError)
      return failureResponse(
        new PushNotificationError({
          code: PushErrorCode.RecipientDisabled,
          message:
            "User has disabled admin notifications. Nothing was sent — they must re-enable notifications in the app before this will reach them.",
        }),
      )
    if (result instanceof InvalidDeviceNotificationsServiceError)
      return failureResponse(
        new PushNotificationError({
          code: PushErrorCode.NoDeviceTokens,
          message:
            "User has no registered device tokens. They may not have logged in on a device with notifications enabled.",
        }),
      )
    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)], success: false }
    }

    return SUCCESS_RESPONSE
  },
})

export default UserNotificationSendMutation
