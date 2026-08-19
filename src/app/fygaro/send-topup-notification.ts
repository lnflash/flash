import {
  sendOutcomeNotification,
  sendOutcomeNotificationBestEffort,
  type OutcomeNotificationArgs,
} from "@app/notifications/send-outcome-notification"

/**
 * Tell the customer how their card top-up ended.
 *
 * This exists to make an app promise true. After a payment the app now says
 * "We've received your payment and are crediting your wallet — we'll let you
 * know as soon as it lands", because a credit can outlive the screen: the
 * transient webhook paths deliberately 500 so Fygaro retries, which can take
 * minutes. Without this, that sentence is a promise nothing keeps.
 *
 * BOTH terminal outcomes notify, and that is deliberate. Sending only on
 * success would keep the promise exactly when it costs nothing and break it in
 * the case that actually matters — the customer whose money was captured and
 * not credited, who is otherwise left watching a screen that said we would be
 * in touch.
 */
export type FygaroTopupNotificationOutcome =
  | "credited"
  // The send is in flight — IBEX reporting IN_FLIGHT is the vendor's own
  // documented 200, so this is an ordinary outcome, not an edge case. Too weak
  // for the `credited` copy ("has been added to your wallet"), which would send
  // the customer to a balance that has not moved; but silence here leaves the
  // very customer this feature exists for with nothing at all.
  //
  // Its copy deliberately promises NO follow-up message. Nothing re-notifies
  // when an in-flight send settles asynchronously, so "we'll let you know when
  // it lands" would be exactly the unkeepable promise this PR was written to
  // retire.
  | "crediting"
  | "heldForReview"

export type FygaroTopupNotificationArgs = {
  accountId: string
  outcome: FygaroTopupNotificationOutcome
  // The NET credited for `credited`, the gross captured for `heldForReview` —
  // in both cases the number the customer would recognise as "the amount this
  // is about".
  amountCents: number
  // The currency the payment was actually captured in, NOT an assumption. The
  // `heldForReview` push fires on refusals that include `non-usd`, so hardcoding
  // USD here rendered a J$6,000 payment as "$6000.00" — a ~150x overstatement in
  // the one message whose whole point is telling the customer what we hold.
  currency: string
}

// Matches the Bridge deposit push (`formatDepositAmount`): major units plus the
// ISO code, so one convention covers every currency without a per-symbol table.
const formatMajorUnits = (amountCents: number): string => (amountCents / 100).toFixed(2)

const toOutcomeArgs = ({
  accountId,
  outcome,
  amountCents,
  currency,
}: FygaroTopupNotificationArgs): OutcomeNotificationArgs => ({
  accountId,
  phraseBase: `notification.fygaroTopup.${outcome}`,
  dataType: `fygaro_topup_${outcome}`,
  amountArg: `${formatMajorUnits(amountCents)} ${currency}`,
  extraData: {
    // MAJOR units, matching `data.amount` on the Bridge deposit push. Sending
    // cents under this key would render a $56.52 credit as $5,652 in any mobile
    // handler that treats `amount` the way every other Payments push does.
    amount: formatMajorUnits(amountCents),
    currency,
  },
})

export const sendFygaroTopupNotification = async (
  args: FygaroTopupNotificationArgs,
): Promise<true | ApplicationError> => sendOutcomeNotification(toOutcomeArgs(args))

export const sendFygaroTopupNotificationBestEffort = async (
  args: FygaroTopupNotificationArgs,
): Promise<void> =>
  sendOutcomeNotificationBestEffort({
    ...toOutcomeArgs(args),
    logMessage: "Failed to send Fygaro top-up push notification",
    logContext: { accountId: args.accountId, outcome: args.outcome },
  })
