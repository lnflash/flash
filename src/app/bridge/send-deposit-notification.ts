import { BridgeConfig } from "@config"

import {
  sendOutcomeNotification,
  sendOutcomeNotificationBestEffort,
  type OutcomeNotificationArgs,
} from "@app/notifications/send-outcome-notification"

const formatDepositAmount = (amount: string, currency: string): string =>
  `${amount} ${currency.toUpperCase()}`

export type BridgeDepositNotificationOutcome = "received" | "processing" | "completed"

export type BridgeDepositNotificationArgs = {
  accountId: string
  amount: string
  currency: string
  outcome?: BridgeDepositNotificationOutcome
}

const toOutcomeArgs = ({
  accountId,
  amount,
  currency,
  outcome = "completed",
}: BridgeDepositNotificationArgs): OutcomeNotificationArgs => ({
  accountId,
  phraseBase: `notification.bridgeDeposit.${outcome}`,
  dataType: `bridge_deposit_${outcome}`,
  amountArg: formatDepositAmount(amount, currency),
  extraData: {
    amount,
    currency: currency == "usdt" ? "USD" : currency.toUpperCase(),
  },
})

export const sendBridgeDepositNotification = async (
  args: BridgeDepositNotificationArgs,
): Promise<true | ApplicationError> => sendOutcomeNotification(toOutcomeArgs(args))

export const sendBridgeDepositNotificationBestEffort = async (
  args: BridgeDepositNotificationArgs,
): Promise<void> => {
  // ENG-466: never push a Bridge deposit notification when the feature is off.
  if (!BridgeConfig.enabled) return

  return sendOutcomeNotificationBestEffort({
    ...toOutcomeArgs(args),
    logMessage: "Failed to send Bridge deposit push notification",
    logContext: { accountId: args.accountId, outcome: args.outcome ?? "completed" },
  })
}
