import { BridgeConfig } from "@config"

import {
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

/**
 * The ONLY entry point, and best-effort by construction — same shape as the
 * Fygaro top-up module.
 *
 * There is deliberately no throwing/error-returning variant: the caller is on a
 * money path where the deposit has already landed, so a notification failure
 * must never become the deposit's failure. An exported variant returning
 * `true | ApplicationError` would be dead code inviting exactly the caller this
 * must not have.
 */
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
