import { GT } from "@graphql/index"

import UserLoginMutation from "@graphql/shared/root/mutation/user-login"
import CaptchaRequestAuthCodeMutation from "@graphql/shared/root/mutation/captcha-request-auth-code"
import CaptchaCreateChallengeMutation from "@graphql/shared/root/mutation/captcha-create-challenge"

import AccountUpdateLevelMutation from "@graphql/admin/root/mutation/account-update-level"
import AccountUpdateStatusMutation from "@graphql/admin/root/mutation/account-update-status"
import AccountSetServiceMutation from "@graphql/admin/root/mutation/account-set-service"
import BusinessUpdateMapInfoMutation from "@graphql/admin/root/mutation/business-update-map-info"

import UserUpdatePhoneMutation from "./root/mutation/user-update-phone"
import BusinessDeleteMapInfoMutation from "./root/mutation/delete-business-map"
import AdminPushNotificationSendMutation from "./root/mutation/admin-push-notification-send"

import MerchantMapDeleteMutation from "./root/mutation/merchant-map-delete"
import MerchantMapValidateMutation from "./root/mutation/merchant-map-validate"
import IssueServiceTokenMutation from "./root/mutation/issue-service-token"

export const mutationFields = {
  unauthed: {
    userLogin: UserLoginMutation,

    captchaCreateChallenge: CaptchaCreateChallengeMutation,
    captchaRequestAuthCode: CaptchaRequestAuthCodeMutation,
  },
  authed: {
    userUpdatePhone: UserUpdatePhoneMutation,
    accountUpdateLevel: AccountUpdateLevelMutation,
    accountUpdateStatus: AccountUpdateStatusMutation,
    accountSetService: AccountSetServiceMutation,
    merchantMapValidate: MerchantMapValidateMutation,
    merchantMapDelete: MerchantMapDeleteMutation,
    businessUpdateMapInfo: BusinessUpdateMapInfoMutation,
    businessDeleteMapInfo: BusinessDeleteMapInfoMutation,
    adminPushNotificationSend: AdminPushNotificationSendMutation,
    issueServiceToken: IssueServiceTokenMutation,
  },
}

export const MutationType = GT.Object<null, GraphQLAdminContext>({
  name: "Mutation",
  fields: () => ({ ...mutationFields.unauthed, ...mutationFields.authed }),
})
