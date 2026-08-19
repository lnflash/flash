import {
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
 * EVERY outcome notifies — the two terminal ones and the in-flight one — and
 * that is deliberate. Sending only on success would keep the promise exactly
 * when it costs nothing and break it in the case that actually matters — the
 * customer whose money was captured and not credited, who is otherwise left
 * watching a screen that said we would be in touch.
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
  // The NET for `credited` and `crediting` (what landed, or is on its way to
  // landing, in the wallet); the GROSS captured for `heldForReview` (what their
  // card statement shows, since nothing has been credited to net against). In
  // every case the number the customer would recognise as "the amount this is
  // about".
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

/**
 * The `data.type` the mobile app switches on. Spelled out per outcome rather
 * than interpolated from it, because the two vocabularies differ: outcomes are
 * camelCase TypeScript identifiers, wire types are snake_case
 * (`bridge_deposit_completed`, `bridge_deposit_processing`). Deriving one from
 * the other shipped `fygaro_topup_heldForReview` — a snake prefix welded to a
 * camel suffix — into a cross-repo contract where correcting it later costs a
 * coordinated release with flash-mobile.
 *
 * Exhaustive by TYPE: a new outcome without an entry here is a compile error,
 * not a push whose casing is silently wrong.
 */
const DATA_TYPE_BY_OUTCOME: Record<FygaroTopupNotificationOutcome, string> = {
  credited: "fygaro_topup_credited",
  crediting: "fygaro_topup_crediting",
  heldForReview: "fygaro_topup_held_for_review",
}

const toOutcomeArgs = ({
  accountId,
  outcome,
  amountCents,
  currency,
}: FygaroTopupNotificationArgs): OutcomeNotificationArgs => ({
  accountId,
  phraseBase: `notification.fygaroTopup.${outcome}`,
  dataType: DATA_TYPE_BY_OUTCOME[outcome],
  amountArg: `${formatMajorUnits(amountCents)} ${currency}`,
  extraData: {
    // MAJOR units, matching `data.amount` on the Bridge deposit push. Sending
    // cents under this key would render a $56.52 credit as $5,652 in any mobile
    // handler that treats `amount` the way every other Payments push does.
    amount: formatMajorUnits(amountCents),
    currency,
  },
})

/**
 * The ONLY entry point, and best-effort by construction.
 *
 * There is deliberately no throwing/error-returning variant: every caller is on
 * a money path where the payment has already been captured, so a notification
 * failure must never become the payment's failure. An exported variant that
 * returns `true | ApplicationError` would be dead code inviting exactly the
 * caller this must not have.
 */
export const sendFygaroTopupNotificationBestEffort = async (
  args: FygaroTopupNotificationArgs,
): Promise<void> =>
  sendOutcomeNotificationBestEffort({
    ...toOutcomeArgs(args),
    logMessage: "Failed to send Fygaro top-up push notification",
    logContext: { accountId: args.accountId, outcome: args.outcome },
  })
