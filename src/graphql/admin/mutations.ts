import { GT } from "@graphql/index"

import AccountUpdateLevelMutation from "@graphql/admin/root/mutation/account-update-level"
import AccountUpdateStatusMutation from "@graphql/admin/root/mutation/account-update-status"
import BusinessUpdateMapInfoMutation from "@graphql/admin/root/mutation/business-update-map-info"

import UserUpdatePhoneMutation from "./root/mutation/user-update-phone"
import BusinessDeleteMapInfoMutation from "./root/mutation/delete-business-map"
import SendNotificationMutation from "./root/mutation/send-notification"

import MerchantMapDeleteMutation from "./root/mutation/merchant-map-delete"
import MerchantMapValidateMutation from "./root/mutation/merchant-map-validate"

export const mutationFields = {
  unauthed: {
  },
  authed: {
    userUpdatePhone: UserUpdatePhoneMutation,
    accountUpdateLevel: AccountUpdateLevelMutation,
    accountUpdateStatus: AccountUpdateStatusMutation,
    merchantMapValidate: MerchantMapValidateMutation,
    merchantMapDelete: MerchantMapDeleteMutation,
    businessUpdateMapInfo: BusinessUpdateMapInfoMutation,
    businessDeleteMapInfo: BusinessDeleteMapInfoMutation,
    sendNotification: SendNotificationMutation,
  },
}

export const MutationType = GT.Object<null, GraphQLAdminContext>({
  name: "Mutation",
  fields: () => ({ ...mutationFields.unauthed, ...mutationFields.authed }),
})
