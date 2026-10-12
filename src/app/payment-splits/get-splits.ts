import {
  PaymentSplitRulesRepository,
  type PaymentSplitRuleRecord,
} from "@services/mongoose/payment-split-rules"

export const getPaymentSplits = async (
  walletId: string,
): Promise<PaymentSplitRuleRecord[] | Error> =>
  PaymentSplitRulesRepository().listByWalletId(walletId)
