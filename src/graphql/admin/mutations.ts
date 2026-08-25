import { GT } from "@graphql/index"

import AccountUpdateLevelMutation from "@graphql/admin/root/mutation/account-update-level"
import AccountUpdateStatusMutation from "@graphql/admin/root/mutation/account-update-status"
import AccountAssignNpubMutation from "@graphql/admin/root/mutation/account-assign-npub"
import AccountReleaseNpubMutation from "@graphql/admin/root/mutation/account-release-npub"
import BusinessUpdateMapInfoMutation from "@graphql/admin/root/mutation/business-update-map-info"
import CashWalletCutoverUpdateMutation from "@graphql/admin/root/mutation/cash-wallet-cutover-update"
import CashWalletCutoverRollbackMutation from "@graphql/admin/root/mutation/cash-wallet-cutover-rollback"

import UserUpdatePhoneMutation from "./root/mutation/user-update-phone"
import BusinessDeleteMapInfoMutation from "./root/mutation/delete-business-map"
import SendNotificationMutation from "./root/mutation/send-notification"
import sendCashoutSettledNotification from "./root/mutation/cashout-notification-send"
import UserNotificationSendMutation from "./root/mutation/user-notification-send"

import MerchantMapDeleteMutation from "./root/mutation/merchant-map-delete"
import MerchantMapValidateMutation from "./root/mutation/merchant-map-validate"

export const mutationFields = {
  unauthed: {},
  authed: {
    userUpdatePhone: UserUpdatePhoneMutation,
    accountUpdateLevel: AccountUpdateLevelMutation,
    accountUpdateStatus: AccountUpdateStatusMutation,
    accountReleaseNpub: AccountReleaseNpubMutation,
    accountAssignNpub: AccountAssignNpubMutation,
    merchantMapValidate: MerchantMapValidateMutation,
    merchantMapDelete: MerchantMapDeleteMutation,
    businessUpdateMapInfo: BusinessUpdateMapInfoMutation,
    businessDeleteMapInfo: BusinessDeleteMapInfoMutation,
    sendNotification: SendNotificationMutation,
    cashoutNotificationSend: sendCashoutSettledNotification,
    userNotificationSend: UserNotificationSendMutation,
    cashWalletCutoverUpdate: CashWalletCutoverUpdateMutation,
    cashWalletCutoverRollback: CashWalletCutoverRollbackMutation,
  },
}

export const MutationType = GT.Object<null, GraphQLAdminContext>({
  name: "Mutation",
  fields: () => ({ ...mutationFields.unauthed, ...mutationFields.authed }),
})
