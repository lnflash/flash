/**
 * Fygaro Payment Webhook Handler
 * Handles payment notifications from Fygaro's payment-button hook.
 *
 * A payment here is fiat that has already been captured on Fygaro's side
 * (card or PayPal). The handler:
 *   1. attributes the payment to a Flash account via customReference
 *      (the app sends the Flash username there — see flash-mobile
 *      CardPayment.tsx),
 *   2. writes the ERPNext audit row (Bridge Transfer Request,
 *      provider=Fygaro) so every card top-up is recorded,
 *   3. posts to the ops activity feed, and
 *   4. when fygaro.credit.enabled: credits the user's cash wallet from the
 *      bank-owner treasury (idempotent on the Fygaro transaction id).
 *
 * Unattributed payments (blank/unknown customReference — every pre-fix app
 * build sends a blank one) are still recorded and alerted so ops can resolve
 * them manually; they are never silently dropped.
 */

import { Request, Response } from "express"

import { FygaroConfig } from "@config"
import { AccountLevel } from "@domain/accounts"
import { CouldNotFindAccountFromUsernameError } from "@domain/errors"
import { ResourceAttemptsLockServiceError } from "@domain/lock"
import { getFlashFeeDiscountPercent } from "@services/frappe/fee-discounts"
import { IdentityRepository } from "@services/kratos"
import { LockService } from "@services/lock"
import { baseLogger } from "@services/logger"
import { AccountsRepository } from "@services/mongoose"
import {
  writeFygaroTopupRequest,
  completeFygaroTopup,
  readFygaroTopupCompletion,
  markFygaroTopupNotCredited,
  sumFygaroTopupGrossCentsLast24h,
} from "@services/frappe/BridgeTransferRequestWriter"
import { alertBridge, generateDedupKey } from "@services/alerts"
import { notifyOpsEvent } from "@services/alerts/ops-events"
// FCM from the fygaro-webhook workload. Nothing reachable from this server
// pushed before, and a missing GOOGLE_APPLICATION_CREDENTIALS fails SILENTLY —
// firebase.ts leaves `messaging` null and push-notifications.ts returns `true`
// anyway, so nothing here can tell a delivered push from a discarded one. The
// server's boot path now pages a critical on that (see `if (!messaging)` in
// ../index.ts), which is the only place it CAN be detected. Verified wired for
// this workload, not inherited from the api pod: lnflash/charts
// `charts/flash/templates/fygaro-webhook-deployment.yaml` sets
// GOOGLE_APPLICATION_CREDENTIALS and mounts the galoyapp-firebase-serviceaccount
// secret under `.Values.galoy.api.firebaseNotifications.enabled` (chart >= 3.2.54;
// deployments pins 3.2.63), and lnflash/deployments
// `tf-modules/flash/flash-values.tmpl.yaml` sets that flag true for test + prod.
// Any new workload that imports this must be checked the same way.
import {
  sendFygaroTopupNotificationBestEffort,
  type FygaroTopupNotificationOutcome,
} from "@app/fygaro/send-topup-notification"

import {
  creditFygaroTopup,
  FygaroCreditError,
  INSUFFICIENT_TREASURY_FLOAT_STEP,
} from "../credit-topup"
import { getFygaroSettings, type FygaroSettings } from "../fygaro-settings"
import { parseCustomReference } from "../../checkout"
import {
  consumeIntent,
  readIntent,
  recordIntentOutcome,
  releaseIntentReservation,
  type FygaroCheckoutIntent,
  type FygaroTopupOutcomeState,
} from "../../checkout-intent-store"
import { evaluateCreditGate, RecordOnlyReason } from "../fees"

type FygaroPaymentPayload = {
  transactionId?: string
  reference?: string
  customReference?: string | null
  amount?: string
  currency?: string
  authCode?: string | null
  createdAt?: string
  client?: { name?: string; email?: string }
}

const centsToDollars = (cents: number): string => (cents / 100).toFixed(2)

// DISPLAY-ONLY fallback attribution for payments whose customReference missed:
// the payer email Fygaro captured at checkout -> Kratos identity (email is a
// login identifier) -> Flash account. Stamping the account on the audit row
// lets the admin Transfer Requests page show the username on every top-up and
// saves ops the manual email->kratos->mongo chase. It must NEVER feed the
// credit path — the checkout email is whatever the payer typed, not verified
// app identity like customReference — so the caller keeps `account`
// (credit-eligible) and this result strictly separate. Best-effort: any
// failure resolves to undefined and the row simply stays unattributed.
const resolveAccountByPayerEmail = async (
  email: string | undefined,
): Promise<Account | undefined> => {
  // Lowercased before the Kratos lookup: checkout keyboards auto-capitalize
  // ("Jabari@gmail.com") while the stored login identifier is lowercase, and
  // listIdentities matches the identifier verbatim — without normalizing here
  // the attribution silently never fires for those payments.
  const trimmed = email?.trim().toLowerCase()
  if (!trimmed) return undefined
  try {
    const userId = await IdentityRepository().getUserIdFromIdentifier(
      trimmed as EmailAddress,
    )
    if (userId instanceof Error) return undefined
    const account = await AccountsRepository().findByUserId(userId)
    if (account instanceof Error) return undefined
    return account
  } catch (error) {
    baseLogger.warn({ error, email: trimmed }, "Fygaro payer-email attribution failed")
    return undefined
  }
}

// Human-readable title for the single record-only ops alert. `credit-disabled`
// is intentionally absent — that is the deploy-level master gate and records
// silently (no anomaly worth paging on).
const RECORD_ONLY_ALERT_TITLE: Record<
  Exclude<RecordOnlyReason, "credit-disabled">,
  string
> = {
  "settings-unavailable":
    "Fygaro Settings unavailable — payment recorded, not auto-credited",
  "auto-credit-disabled":
    "Fygaro auto-credit disabled in settings — payment recorded, not auto-credited",
  "non-usd": "Fygaro payment in unexpected currency — not auto-credited",
  "over-limit": "Fygaro payment over the auto-credit limit — not auto-credited",
  "no-daily-limit-for-level":
    "Fygaro payment from an account level with no daily top-up limit — not auto-credited",
  "history-unavailable":
    "Fygaro top-up history unavailable — payment recorded, not auto-credited",
  "daily-limit-exceeded":
    "Fygaro payment exceeds the account's daily top-up limit — not auto-credited",
  "under-minimum": "Fygaro payment below the minimum top-up — not auto-credited",
  "intent-mismatch":
    "Fygaro payment does not match the checkout Flash signed for it — not auto-credited",
  "non-positive-net": "Fygaro payment net after fees is not positive — not auto-credited",
}

// The number behind a threshold refusal, so the customer can be told "above
// your $125 daily limit" rather than "declined". Only the gates that turn on a
// threshold have one; everything else is our fault, not theirs, and gets no
// number because there is none to give.
//
// `daily-limit-exceeded` sends what is LEFT, not the cap. The customer-facing
// sentence built from this number says "more than your REMAINING daily top-up
// limit of $X", and the cap is not that: a level-1 account that has spent $100
// of $125 and pays $60 would be told "$60 is more than your remaining limit of
// $125.00" — arithmetically false, and it withholds the only actionable figure,
// the $25 actually left.
const thresholdCentsFor = (
  reason: RecordOnlyReason,
  settings: FygaroSettings | undefined,
  level: AccountLevel,
  priorDayGrossCents: number | undefined,
): number | undefined => {
  if (!settings) return undefined
  if (reason === "daily-limit-exceeded") {
    const capUsd = settings.dailyTopupLimits[level]
    // `history-unavailable` precedes this gate, so the prior sum is defined
    // whenever the reason is `daily-limit-exceeded`. If it somehow is not, send
    // no number at all rather than the cap — the generic wording is honest, a
    // wrong number is not.
    if (capUsd === undefined || priorDayGrossCents === undefined) return undefined
    return Math.max(0, Math.round(capUsd * 100) - priorDayGrossCents)
  }
  const usd =
    reason === "over-limit"
      ? settings.autoCreditLimit
      : reason === "under-minimum"
        ? settings.minimumTopup
        : undefined
  return usd === undefined ? undefined : Math.round(usd * 100)
}

/**
 * Which refusals earn the customer the "we have your payment and are completing
 * it manually — we'll let you know when it lands" push.
 *
 * Exhaustive by TYPE, not by omission: adding a `RecordOnlyReason` without a
 * value here is a compile error, so a new gate can never silently inherit a
 * promise about what happens next. The copy is a commitment that a human will
 * hand-credit this payment, so a reason only belongs here when that is the real
 * outcome.
 *
 * DEPENDS ON `fygaro.checkout.enabled`. This table says which reasons MAY push;
 * REFUSAL_NEEDS_VERIFIED_REFERENCE below says which ones additionally need a
 * server-signed reference, and a signed reference only exists when server-side
 * checkout is on — the flag defaults to `false` (config/schema.ts) and turning
 * it on needs a Fygaro Pro-or-above plan. So with checkout OFF, or for any
 * legacy app build still in the wild, the only refusal that actually reaches a
 * customer is the one marked `false` in that second table. Read the two
 * together; neither is the whole answer on its own.
 */
const REFUSAL_NOTIFIES_CUSTOMER: Record<RecordOnlyReason, boolean> = {
  // The deploy-level master gate. Records without crediting BY DESIGN, so
  // pushing here would notify every paying customer during a rollout.
  "credit-disabled": false,
  // The operator's ERPNext runtime kill switch — the one ops actually flips
  // during an incident. Same mass-push problem as the master gate.
  "auto-credit-disabled": false,
  // Transient: the route answers 500 and never reaches this branch. Listed so
  // the record stays exhaustive.
  "settings-unavailable": false,
  "history-unavailable": false,
  // Fees already meet or exceed the gross — nothing will ever land, so
  // promising that it will is a lie.
  "non-positive-net": false,
  // The payment does not match the checkout we signed. That is a refund or an
  // escalation, not a hand-credit, and we should not commit to crediting a
  // payment we cannot account for.
  "intent-mismatch": false,
  // Captured fiat that a human has to finish by hand — exactly what the copy
  // says. `non-usd` included: the push now names the payment's real currency
  // (see FygaroTopupNotificationArgs), so it reads truthfully off USD.
  "non-usd": true,
  "over-limit": true,
  "no-daily-limit-for-level": true,
  "daily-limit-exceeded": true,
  "under-minimum": true,
}

/**
 * Which of those refusals ALSO require a server-verified reference before the
 * push goes out.
 *
 * On legacy unsigned clients `customReference` is free text the PAYER types, so
 * anyone can pay with a stranger's username on it and have the bank's own app
 * tell that stranger we are holding a payment of theirs — a ready-made pretext
 * for a follow-up scam call. What makes that worth blocking is the PRICE: the
 * gates below all trip on amounts an attacker is happy to spend.
 *
 * `over-limit` is the exception, and the reason this is a per-reason table
 * rather than one blanket `authorizedIntent &&`. It trips only when the gross
 * EXCEEDS the operator's single-payment auto-credit limit (fees.ts), so buying
 * that push costs the attacker more than the limit — real money that ops then
 * hand-credits to the VICTIM. That is the same self-defeating economics that
 * leaves the `credited` push ungated, and gating it bought nothing while
 * silencing the reason most likely to be the one a real customer hits.
 *
 * The rest stay gated because they are cheap: `under-minimum` costs whatever is
 * below the operator minimum, `non-usd` costs a single Jamaican dollar, and
 * `daily-limit-exceeded` / `no-daily-limit-for-level` cost nothing at all when
 * the victim already sits at their cap (both are checked before the minimum
 * gate). Legacy clients keep the pre-PR behaviour for those — ops alert only,
 * no push — until they are out of the wild.
 *
 * Exhaustive by TYPE for the same reason as the table above: a new gate must
 * make this call explicitly rather than inherit either answer.
 */
const REFUSAL_NEEDS_VERIFIED_REFERENCE: Record<RecordOnlyReason, boolean> = {
  // Costs the attacker more than the auto-credit limit, paid to the victim.
  "over-limit": false,
  // Cheap enough to be a scam pretext — a signed reference is required.
  "non-usd": true,
  "under-minimum": true,
  "daily-limit-exceeded": true,
  "no-daily-limit-for-level": true,
  // Never push at all (REFUSAL_NOTIFIES_CUSTOMER above), so this value is
  // unreachable. Listed so the record stays exhaustive and a reason promoted to
  // notifying cannot arrive here without an answer.
  "credit-disabled": true,
  "auto-credit-disabled": true,
  "settings-unavailable": true,
  "history-unavailable": true,
  "non-positive-net": true,
  "intent-mismatch": true,
}

// Read off `creditFygaroTopup` itself rather than restated as a literal union:
// a restated one stays "complete" when the source grows a status, and the only
// thing left to catch it would be an out-of-range index — which this repo
// compiles with `noImplicitAny: false` and therefore does not report.
type FygaroCreditStatus = Exclude<
  Awaited<ReturnType<typeof creditFygaroTopup>>,
  FygaroCreditError
>["status"]

/**
 * Which push a successful credit path earns, keyed by what the send actually
 * reported.
 *
 * A Record rather than a ternary, for the same reason REFUSAL_NOTIFIES_CUSTOMER
 * above is one: the difference between "N USD has been added to your wallet"
 * and "we're crediting it now" is a claim about the customer's balance, and a
 * ternary hands every future status the fallback arm silently. Add a status to
 * `creditFygaroTopup` and this object is missing a key — a compile error, not a
 * customer told their money landed when it did not.
 */
const OUTCOME_BY_CREDIT_STATUS: Record<
  FygaroCreditStatus,
  FygaroTopupNotificationOutcome
> = {
  success: "credited",
  // IBEX reporting IN_FLIGHT is the vendor's documented 200, so this is a
  // routine outcome — too weak for the credited copy, too real for silence.
  pending: "crediting",
}

export const paymentHandler = async (req: Request, res: Response) => {
  const payload = (req.body ?? {}) as FygaroPaymentPayload
  const { transactionId, createdAt } = payload
  const currency = (payload.currency ?? "USD").toUpperCase()
  // `custom_reference` is either a bare username (built on-device by app
  // versions predating signed checkout, and editable by the payer) or
  // `username|intentId` minted by authorizeFygaroTopup. Both are accepted for
  // as long as older clients are in the wild; only the second can be verified.
  const reference = parseCustomReference(payload.customReference)
  const username = reference?.username
  const intentId = reference?.intentId

  if (!transactionId || !payload.amount) {
    baseLogger.warn(
      { transactionId, has_amount: Boolean(payload.amount) },
      "Fygaro payment webhook rejected: missing required fields",
    )
    return res.status(400).json({
      error: "Invalid payload",
      detail: "Missing one or more required fields: transactionId, amount",
    })
  }

  // A non-numeric amount (e.g. "abc") is a malformed payload, not a real
  // payment — reject it with 400 up front so it never reaches the credit gate.
  // Otherwise Math.round(Number("abc") * 100) is NaN, which slips past every
  // numeric gate (all NaN comparisons are false) into the credit path, where
  // creditFygaroTopup rejects it and fires the CRITICAL "auto-credit failed"
  // alert — misclassifying garbage input as a credit failure and paging ops.
  // Fygaro does not retry 4xx, which is correct here: a retry cannot make
  // "abc" numeric.
  const grossAmount = Number(payload.amount)
  if (!Number.isFinite(grossAmount)) {
    baseLogger.warn(
      { transactionId, amount: payload.amount },
      "Fygaro payment webhook rejected: non-numeric amount",
    )
    return res.status(400).json({
      error: "Invalid payload",
      detail: "amount is not a finite number",
    })
  }

  try {
    baseLogger.info(
      {
        transactionId,
        amount: payload.amount,
        currency,
        username,
        reference: payload.reference,
      },
      "Fygaro payment event",
    )

    // Attribution: customReference carries the Flash username. A blank or
    // unknown reference still gets recorded — that IS the failure mode this
    // webhook exists to surface.
    let account: Account | undefined
    if (username) {
      const found = await AccountsRepository().findByUsername(username as Username)
      if (found instanceof CouldNotFindAccountFromUsernameError) {
        // A genuine miss: no account owns this username. Fall through to the
        // display-only payer-email fallback below.
        baseLogger.warn(
          { transactionId, username },
          "Fygaro payment: customReference does not match any account",
        )
      } else if (found instanceof Error) {
        // A repository FAULT (Mongo timeout, connection blip) is NOT "no such
        // username": findByUsername returns CouldNotFindAccountFromUsernameError
        // for a real miss and parseRepositoryError(err) for everything else.
        // Collapsing the two would let a momentary outage on a RE-DELIVERY drop
        // a perfectly-referenced payment into the payer-email fallback and stamp
        // the sticky `email_attribution` marker onto a row whose account_id was
        // already verified via customReference — permanently exempting an
        // already-credited top-up from the daily-cap sum
        // (ErpNext.sumFygaroTopupGrossCentsSince), so the account's spent
        // allowance reads $0 and it can auto-credit its full cap again. It would
        // also ack 200 and strand the payment for manual credit. Same self-heal
        // policy this handler applies to transient ERPNext reads below: 500 and
        // no dedupe lock — let Fygaro retry once Mongo is back.
        baseLogger.error(
          { error: found, transactionId, username },
          "Fygaro payment: account lookup failed — returning 500 so Fygaro retries",
        )
        // Record the payment UNATTRIBUTED first. The retry above is a policy,
        // not a guarantee — if Fygaro's retry budget expires before Mongo
        // recovers, bailing without a write would leave captured fiat with no
        // server-side record at all, which is the exact failure class this
        // webhook was built to end. Deliberately no account_id and no
        // `email_attribution` marker: a later retry upserts the verified
        // account_id onto this same row and the daily-cap sum still counts it
        // once attributed. A failure here needs no extra handling — the
        // response is already 500, so Fygaro retries either way.
        const faultAudit = await writeFygaroTopupRequest({
          transactionId,
          amount: String(payload.amount),
          currency,
          accountId: undefined,
          emailAttributed: false,
          createdAt,
          rawPayload: req.body,
        })
        if (faultAudit instanceof Error) {
          baseLogger.error(
            { error: faultAudit, transactionId },
            "Failed to persist unattributed Fygaro audit row during an account-lookup fault",
          )
        }
        // Critical, not warning: this means captured payments are not being
        // attributed or credited at all. The dedup key is static, so PagerDuty
        // groups a whole outage into ONE incident rather than paging per
        // payment — the same reason the audit-write failure below pages.
        alertBridge({
          dedupKey: generateDedupKey.fygaroAccountLookupFailed(),
          source: "fygaro-webhook",
          severity: "critical",
          title:
            "Fygaro account lookup unavailable — payments recorded unattributed, will retry",
          detail: found.message,
          context: { transaction_id: transactionId, username },
        })
        return res.status(500).json({ error: "account lookup unavailable; will retry" })
      } else {
        account = found
      }
    }

    // Fallback attribution for the audit row only (never for crediting):
    // resolved from the checkout payer email when customReference missed.
    const emailAttributedAccount = account
      ? undefined
      : await resolveAccountByPayerEmail(payload.client?.email)

    // Stamp what we know about this payment so the app can stop guessing. Never
    // throws and never blocks: this rides the money-moving path, and a status
    // write is not worth failing a credit over.
    //
    // Declared HERE, above the audit write, because the very first thing worth
    // stamping happens the moment that write succeeds — and because the
    // unattributed branch below is terminal too: it needs nothing but
    // `intentId`, and leaving it out of reach is what left a customer polling
    // PROCESSING forever on a payment ops was crediting by hand.
    const recordOutcome = async (outcome: {
      state: FygaroTopupOutcomeState
      reason?: string
      netAmountCents?: number
      detailCents?: number
    }) => {
      if (!intentId) return
      await recordIntentOutcome({
        intentId,
        // Stamped with the TRANSACTION, not just the intent. The record is
        // keyed on the intent, but one signed link can be paid twice inside its
        // window, so an outcome that does not name the payment it is about
        // cannot be used to decide anything about a different payment — see the
        // already-credited guard below.
        outcome: { ...outcome, transactionId, atMs: Date.now() },
        ttlSeconds: FygaroConfig.checkout?.ttlSeconds ?? 900,
      })
    }

    const auditResult = await writeFygaroTopupRequest({
      transactionId,
      amount: String(payload.amount),
      currency,
      accountId: account?.id ?? emailAttributedAccount?.id,
      emailAttributed: Boolean(emailAttributedAccount),
      createdAt,
      rawPayload: req.body,
    })
    if (auditResult instanceof Error) {
      baseLogger.error(
        { error: auditResult, transactionId },
        "Failed to persist Fygaro ERPNext audit row",
      )
      alertBridge({
        dedupKey: generateDedupKey.erpnextFygaroAudit(transactionId),
        source: "erpnext-audit",
        severity: "critical",
        title: "Fygaro payment ERPNext audit write failed",
        detail: auditResult.message,
        context: { transaction_id: transactionId },
      })
      notifyOpsEvent({
        flow: "deposit",
        phase: "failed",
        status: "failed",
        step: "erpnext-audit",
        error: auditResult.constructor.name,
        amount: { value: String(payload.amount), currency },
        meta: { provider: "Fygaro", transactionId },
      })
      // 500 so Fygaro retries and the audit gap can self-heal.
      return res.status(500).json({ error: "Failed to persist audit row" })
    }

    // The payment is now an OBSERVED fact, recorded on our side — which is the
    // first moment "we have your payment" is a claim the server can back.
    //
    // Without this stamp the status query has only the intent record, and that
    // is written when the checkout link is MINTED, not when it is paid. Reading
    // "no outcome" as PROCESSING therefore told a customer whose card was
    // DECLINED that their payment had been received and was being credited —
    // the same unbacked claim this workstream exists to delete, moved one
    // screen later and given a server response to stand on. `recordIntentOutcome`
    // refuses to let this overwrite a terminal outcome, so a re-delivery of an
    // already-credited payment cannot walk the answer backwards.
    await recordOutcome({ state: "received" })

    // Look the authorisation up ONCE, and do it BEFORE the unattributed branch
    // below, so every terminal answer in this handler can let go of the hold
    // the authorisation still has on the account's daily allowance. A leaked
    // hold is not cosmetic: the audit row already counts the payment towards
    // the cap, so a hold left behind on top of it double-counts one payment for
    // the rest of the JWT's window and refuses the account's next legitimate
    // top-up — piling a second failure onto an already-bad event.
    //
    // The read is NON-DESTRUCTIVE. This handler answers 500 on the transient
    // stops below so the provider retries; consuming here would burn the
    // authorisation on a delivery that credited nothing, leaving the retry that
    // actually moves money — the one most worth verifying — with nothing to
    // check against.
    let authorizedIntent: FygaroCheckoutIntent | undefined
    if (intentId) {
      const lookup = await readIntent(intentId)
      if (lookup.found) {
        authorizedIntent = lookup.intent
      } else {
        baseLogger.info(
          { transactionId, intentId },
          "Fygaro payment references an intent that is expired, consumed or unknown",
        )
      }
    }

    /**
     * Drop the authorisation's hold on the daily allowance WITHOUT consuming the
     * record.
     *
     * For terminal answers that did not move money: the hold must go (it is
     * holding allowance against a payment that is already counted in ERPNext),
     * but the record must stay, so a later manual credit still has the
     * cross-check of what we originally authorised.
     */
    const releaseAuthorizedHold = async () => {
      if (authorizedIntent) await releaseIntentReservation(authorizedIntent)
    }

    if (!account) {
      // Dedupe re-deliveries before emitting: alertBridge is TTL-deduped but
      // the ops feed is not, so a Fygaro retry of an unattributed payment
      // would otherwise spam a feed line per delivery. Taken only after the
      // audit write succeeds so retries can still repair transient failures.
      const dedupe = await LockService().lockIdempotencyKey(
        `fygaro-payment:${transactionId}` as IdempotencyKey,
      )
      if (dedupe instanceof Error) {
        baseLogger.info({ transactionId }, "Duplicate Fygaro payment webhook")
        // Terminal for this payment too, so stamp it for the same reason the
        // non-deduped return below does. A re-delivery arriving after a first
        // delivery whose Redis stamp failed would otherwise leave the app
        // polling PROCESSING forever on a payment ops is crediting by hand.
        await recordOutcome({ state: "held-for-review", reason: "unattributed" })
        return res.status(200).json({ status: "already_processed" })
      }
      // When the payer email resolved to an account, name the username in the
      // alert so ops can start from a candidate instead of re-running the
      // email->kratos->mongo chase by hand. It is a LEAD, not an instruction:
      // the checkout email is payer-typed and identity-unverified (a relative
      // or an attacker can type anyone's address), so the alert says confirm
      // before crediting rather than "credit this account".
      const resolvedUsername = emailAttributedAccount?.username
      alertBridge({
        dedupKey: generateDedupKey.fygaroUnattributed(transactionId),
        source: "fygaro-webhook",
        severity: "warning",
        title: "Fygaro payment could not be attributed to an account",
        detail: resolvedUsername
          ? `customReference=${username ?? "<blank>"} — UNVERIFIED payer-email match on @${resolvedUsername}; confirm the payer owns this account before crediting`
          : `customReference=${username ?? "<blank>"} — manual attribution needed`,
        context: {
          transaction_id: transactionId,
          amount: String(payload.amount),
          client_email: payload.client?.email,
          ...(resolvedUsername ? { email_matched_username: resolvedUsername } : {}),
        },
      })
      notifyOpsEvent({
        flow: "deposit",
        phase: "fygaro-unattributed",
        status: "pending",
        accountId: emailAttributedAccount?.id,
        amount: { value: String(payload.amount), currency },
        meta: {
          provider: "Fygaro",
          transactionId,
          reference: username ?? "blank",
          email: payload.client?.email ?? "unknown",
          ...(resolvedUsername ? { emailMatchedUsername: resolvedUsername } : {}),
        },
      })
      // Terminal (the dedupe lock above is non-releasing, so retries ack
      // "already_processed"): a signed reference whose username no longer
      // resolves never reaches the redemption paths below, so release its hold
      // here or it sits on the allowance until the JWT expires.
      await releaseAuthorizedHold()
      // ...and stamp, for the same reason the hold is released: this IS the
      // final answer for this payment. A signed checkout whose username stopped
      // resolving between minting and paying leaves an app polling the status
      // query; without a stamp it polls PROCESSING until the record expires
      // while ops credits the payment by hand. `unattributed` is one of ours,
      // not the customer's, and the status resolver words it that way.
      await recordOutcome({ state: "held-for-review", reason: "unattributed" })
      return res.status(200).json({ status: "recorded", attributed: false })
    }
    const accountId = account.id

    // Fee-aware gate: credit the NET (gross minus processor + Flash fees), and
    // only when every gate holds. The fees/threshold/minimum/toggle live in the
    // ERPNext "Fygaro Settings" doctype, read through a 60s cache; the yaml
    // FygaroConfig.credit.enabled stays the deploy-level master gate. Settings
    // are only read when credit is enabled — a disabled deploy never touches
    // ERPNext for this.
    const creditEnabled = Boolean(FygaroConfig.credit?.enabled)
    const grossCents = Math.round(grossAmount * 100)
    // Cross-check the payment against what the server authorised (read above),
    // when the reference carries an intent. The signed JWT already prevents the
    // customer altering the amount, so a mismatch here means something on OUR
    // side is wrong — a signing bug, a stale intent, a replay — and quietly
    // crediting a payment we cannot account for is the failure this whole
    // workstream is about. A missing intent is NOT treated as a mismatch: it is
    // the legacy position (unverified), and the credit gate below still applies
    // in full.
    //
    // The intent is redeemed on the terminal paths (`redeemIntent` below), which
    // is also where its hold on the account's daily allowance is released; the
    // terminal paths that did NOT move money release the hold alone
    // (`releaseAuthorizedHold`), keeping the record for a manual credit.
    let intentMismatch: string | undefined
    if (authorizedIntent) {
      if (authorizedIntent.amountCents !== grossCents) {
        intentMismatch = `authorised ${authorizedIntent.amountCents}c, paid ${grossCents}c`
      } else if (accountId && authorizedIntent.accountId !== accountId) {
        intentMismatch = `authorised for account ${authorizedIntent.accountId}, paid as ${accountId}`
      }
    }

    // Terminal-path redemption: atomic, so a replayed authorisation is claimed
    // exactly once. Deliberately not awaited for its answer — losing the claim
    // means another delivery already redeemed it, which changes nothing about
    // this payment's outcome.
    const redeemIntent = async () => {
      if (intentId) await consumeIntent(intentId)
    }

    const settings = creditEnabled ? await getFygaroSettings() : undefined

    // Trailing-24h charged gross for the per-level daily cap, read only when a
    // credit could actually happen (deploy gate on, settings readable,
    // auto-credit toggle on, USD). The cheaper deterministic gates come first:
    // with the operator kill switch off or a non-USD payment, gate ordering
    // guarantees an `auto-credit-disabled`/`non-usd` stop before the history
    // gates are ever consulted, so skipping the ERPNext list query here can
    // never surface a false `history-unavailable`. A failed read stays
    // `undefined` — never coerced to 0, which would treat a history outage as
    // a clean slate — and the gate turns it into the retryable
    // `history-unavailable` stop.
    let priorDayGrossCents: number | undefined
    let flashFeeDiscountPercent = 0
    if (creditEnabled && settings?.autoCreditEnabled && currency === "USD") {
      const priorSum = await sumFygaroTopupGrossCentsLast24h({
        accountId,
        excludeTransactionId: transactionId,
      })
      if (priorSum instanceof Error) {
        baseLogger.warn(
          { error: priorSum, transactionId },
          "Failed to read Fygaro top-up history; treating as unavailable",
        )
      } else {
        priorDayGrossCents = priorSum
      }

      // Flash-fee discount from the operator's Fee Discount whitelist, read
      // under the same could-actually-credit guard as the history read.
      // Fail-open: the reader resolves to 0 on any failure, so an unreadable
      // whitelist charges the standard fee instead of blocking the credit.
      flashFeeDiscountPercent = await getFlashFeeDiscountPercent({
        username: account.username,
        flow: "topup",
      })
    }

    // A mismatch overrides every other outcome: the gate can only reason about
    // the payment in front of it, not about whether we ever authorised it.
    const gate = intentMismatch
      ? ({ credit: false, reason: "intent-mismatch" } as const)
      : evaluateCreditGate({
          creditEnabled,
          currency,
          settings,
          grossCents,
          level: account.level,
          priorDayGrossCents,
          flashFeeDiscountPercent,
        })

    if (!gate.credit) {
      // `settings-unavailable` and `history-unavailable` are TRANSIENT (an
      // ERPNext blip; settings reads are additionally cached-undefined for up
      // to 60s) — unlike the deterministic reasons below, a retry seconds
      // later would auto-credit cleanly. Acking 200 (record-only) would stop
      // Fygaro retrying and permanently downgrade the payment to manual credit
      // over a momentary outage. Return 500 so Fygaro retries and the read
      // self-heals once ERPNext recovers; it still never credits off missing
      // data — the retry simply re-reads. Deliberately do NOT take the
      // non-releasing dedupe lock here (it would make the very next retry ack
      // 200 "already_processed" and defeat the self-heal), and skip the
      // ops-feed line (it can't be deduped without that lock, so per-retry
      // emission would spam the feed during an outage). alertBridge is
      // TTL-deduped, so a genuine sustained outage still pages without spamming.
      if (
        gate.reason === "settings-unavailable" ||
        gate.reason === "history-unavailable"
      ) {
        baseLogger.warn(
          { transactionId, reason: gate.reason },
          "Fygaro ERPNext read unavailable — returning 500 so Fygaro retries and the read self-heals",
        )
        alertBridge({
          dedupKey: generateDedupKey.fygaroNotCredited(transactionId),
          source: "fygaro-webhook",
          severity: "warning",
          title: RECORD_ONLY_ALERT_TITLE[gate.reason],
          detail: `reason=${gate.reason} currency=${currency} gross=${centsToDollars(grossCents)}`,
          context: {
            transaction_id: transactionId,
            amount: String(payload.amount),
            reason: gate.reason,
          },
        })
        return res.status(500).json({ error: "ERPNext read unavailable; will retry" })
      }

      // Already credited? Then this refusal is about a payment that has ALREADY
      // been delivered, and every line below it would write a falsehood over
      // the truth. The credit path guards on this marker; the record-only path
      // must guard on it too, because a payment that credited on an earlier
      // delivery CAN come back through the gate and be refused:
      //
      //   tx1 ($60) credits — Completed, no failure_reason, counts in the sum.
      //   tx2 ($100) is refused `daily-limit-exceeded` and stamped uncredited.
      //   Ops hand-credits tx2, and `sumFygaroTopupGrossCentsSince` correctly
      //   counts a Completed row again whatever reason it once carried.
      //   Fygaro re-delivers tx1 hours later: prior is now $100, $100+$60 is
      //   over the $125 cap, and the gate refuses money already in the wallet.
      //
      // Nothing below stops that on its own. The record-only timelock lives in
      // a DIFFERENT redis namespace (`locks:idempotencykey:`) from the credit
      // path's releasing lock (`locks:payment-idempotency:`), so it is still
      // free on such a re-delivery. Unguarded, this pages ops with a false
      // "manual credit needed", stamps a `failure_reason` onto tx1's Completed
      // row, and overwrites the customer's CREDITED status with "held for
      // review — more than your remaining daily limit" for $60 they already have.
      const priorCompletion = await readFygaroTopupCompletion(transactionId)
      // TWO markers, because the first one can lag the money. Promoting the
      // ERPNext row is itself a write this handler alerts on when it fails
      // ("Fygaro credit succeeded but ERPNext promotion failed", below): after
      // that the money IS in the wallet and the row still reads Fiat Received.
      // A guard that asks only ERPNext walks straight past it, and the refusal
      // reasons that reach here are ordinary — `auto-credit-disabled` is
      // exactly what ops flip while cleaning up the very ERPNext incident that
      // broke the promotion.
      //
      // The recorded outcome is the second marker: it is stamped from the
      // credit path independently of whether the promotion succeeded, so
      // between them they cover each other's gap.
      //
      // It must name THIS transaction. `priorCompletion` is keyed on the
      // transaction; the intent record is keyed on the intent, and one signed
      // link can be paid more than once inside its 900s window — the replay
      // `authorizeFygaroTopup` already guards against. Accepting any `credited`
      // stamp on the intent turns tx1's credit into an answer about tx2:
      // customer pays a $100 link twice, tx1 credits and stamps the intent, tx2
      // arrives, the gate correctly refuses `daily-limit-exceeded`, and this
      // branch acks 200 `already_processed` for it — no
      // `markFygaroTopupNotCredited` (so it eats the cap for 24h), no alert, no
      // ops-feed line, and `fygaroTopupStatus` reports CREDITED with tx1's net
      // for a second real capture that never reached the wallet. It would also
      // swallow `intent-mismatch`, the one reason that exists to catch a replay.
      //
      // A record with no `transactionId` (written before that field existed)
      // does not match either, so it falls through to the record-only path —
      // an extra ops alert, never a silently-swallowed capture.
      const creditedOutcome =
        authorizedIntent?.outcome?.state === "credited" &&
        authorizedIntent.outcome.transactionId === transactionId
          ? authorizedIntent.outcome
          : undefined
      if (priorCompletion.completed || creditedOutcome) {
        baseLogger.info(
          { transactionId, reason: gate.reason },
          "Fygaro payment already credited — ignoring a late record-only refusal",
        )
        // With the net read back off the completed row. This branch exists for
        // the case where the FIRST delivery's stamp never landed, so there is
        // usually no recorded outcome for the store-side merge to preserve —
        // stamping `credited` with no amount would show the customer a credited
        // top-up and no figure, against a schema that promises `netAmount` is
        // present once credited.
        await recordOutcome({
          state: "credited",
          netAmountCents:
            priorCompletion.netAmountCents ?? creditedOutcome?.netAmountCents,
        })
        return res.status(200).json({ status: "already_processed" })
      }

      // Deterministic record-only path (non-usd, over-limit,
      // no-daily-limit-for-level, daily-limit-exceeded, under-minimum,
      // non-positive-net, auto-credit-disabled, and the silent credit-disabled
      // master gate): these will never change on retry, so ack 200 and dedupe
      // with a non-releasing timelock. Nothing money-moving happens here. Taken
      // only after the audit write succeeds so provider retries can recover
      // audit gaps after transient persistence failures.
      const lockResult = await LockService().lockIdempotencyKey(
        `fygaro-payment:${transactionId}` as IdempotencyKey,
      )
      if (lockResult instanceof Error) {
        baseLogger.info({ transactionId }, "Duplicate Fygaro payment webhook")
        // Stamp before returning, the same argument as the credit path's
        // already-processed short-circuit. `recordIntentOutcome` swallows its
        // write failures by design, so a first delivery that took this lock and
        // then failed its Redis stamp leaves EVERY retry short-circuiting here
        // — and the customer polling "processing" until the record expires, for
        // a payment that is permanently held for review. The gate ran on this
        // delivery too, so the reason and number are in hand and identical.
        await recordOutcome({
          state: "held-for-review",
          reason: gate.reason,
          detailCents: thresholdCentsFor(
            gate.reason,
            settings,
            account.level,
            priorDayGrossCents,
          ),
        })
        return res.status(200).json({ status: "already_processed" })
      }
      if (gate.reason !== "credit-disabled") {
        // credit-disabled is the deploy-level master gate and records
        // silently. Every other reason means credit IS supposed to be on but
        // this specific payment was skipped — page a human, naming the gate,
        // since it leaves fiat sitting uncredited.
        alertBridge({
          dedupKey: generateDedupKey.fygaroNotCredited(transactionId),
          source: "fygaro-webhook",
          severity: "warning",
          title: RECORD_ONLY_ALERT_TITLE[gate.reason],
          detail: `reason=${gate.reason} currency=${currency} gross=${centsToDollars(grossCents)} level=${account.level}${
            intentMismatch ? ` mismatch=${intentMismatch}` : ""
          }`,
          context: {
            transaction_id: transactionId,
            amount: String(payload.amount),
            reason: gate.reason,
            username,
            account_level: account.level,
            // Without these numbers the alert says a payment was refused but
            // not what it was refused against, which is the only thing that
            // tells an operator whether to credit it by hand.
            ...(intentMismatch ? { intent_mismatch: intentMismatch } : {}),
          },
        })
      }
      notifyOpsEvent({
        flow: "deposit",
        phase: "fygaro-recorded",
        status: "pending",
        accountId,
        amount: { value: String(payload.amount), currency },
        meta: {
          provider: "Fygaro",
          transactionId,
          username: username ?? "",
          reason: gate.reason,
        },
      })
      // Terminal: this reason will not change on retry, so the authorisation is
      // spent and its hold on the daily allowance must be released.
      await redeemIntent()
      // Take the row OUT of the allowance sum and give ops the reason. An
      // uncredited payment delivered no value, so it must not spend the
      // allowance that governs value delivered — otherwise this refusal
      // refuses the customer's next legitimate top-up too.
      const marked = await markFygaroTopupNotCredited({
        transactionId,
        accountId,
        amount: String(payload.amount),
        currency,
        reason: gate.reason,
        rawPayload: payload,
      })
      if (marked instanceof Error) {
        // The one write on this path that carries the behaviour change, so it
        // is the last one that can be allowed to fail silently. The dedupe
        // timelock above is non-releasing and already taken, so Fygaro's next
        // retry acks "already_processed" and nothing self-heals: the row keeps
        // no `failure_reason`, stays inside the trailing-24h sum, and this
        // refused payment goes on consuming the customer's cap for 24h —
        // refusing their next LEGITIMATE top-up, which is precisely the failure
        // this stamp exists to end. Critical and paged, matching the audit
        // write above, because only a human can repair it now.
        baseLogger.error(
          { error: marked, transactionId, reason: gate.reason },
          "Failed to stamp a Fygaro refusal as not-credited",
        )
        alertBridge({
          // Its OWN key, not `erpnextFygaroAudit`. That key is claimed by the
          // audit-WRITE failure above, and the delivery order that produces
          // THIS failure is exactly the one that produces that one first:
          // write fails -> critical fires -> 500 -> Fygaro retries minutes
          // later -> write succeeds, the gate refuses, and the stamp fails.
          // Within informDedupTtlMs (60 minutes) Slack/Discord would suppress
          // this alert and PagerDuty would fold it into the open incident —
          // silently swallowing the one that says a customer's cap is being
          // consumed by a payment they never received value for.
          dedupKey: generateDedupKey.fygaroRefusalNotStamped(transactionId),
          source: "erpnext-audit",
          severity: "critical",
          title:
            "Fygaro refusal not stamped — payment still counts against the customer's daily allowance",
          detail: marked.message,
          context: {
            transaction_id: transactionId,
            reason: gate.reason,
            account_id: accountId,
          },
        })
      }
      await recordOutcome({
        state: "held-for-review",
        reason: gate.reason,
        // The number the customer needs to hear back. Only the gates that turn
        // on a threshold have one; the rest are our problems, not theirs.
        detailCents: thresholdCentsFor(
          gate.reason,
          settings,
          account.level,
          priorDayGrossCents,
        ),
      })

      // Notify on the REFUSAL too. Telling the customer only when the money
      // arrives keeps the promise exactly when it costs nothing and breaks it
      // for the person whose payment was captured and not credited — who is
      // otherwise left on a screen that said we would be in touch. Only for the
      // reasons where a human really does finish the payment by hand
      // (REFUSAL_NOTIFIES_CUSTOMER above); the rest would be promising something
      // that is not going to happen.
      //
      // ...and, for the CHEAP reasons, only against a SERVER-VERIFIED
      // reference. `authorizedIntent` is set only when the reference carries an
      // intentId that Flash itself minted and signed for this account and this
      // amount (see readIntent above; a mismatch on either lands as
      // `intent-mismatch`, which the allowlist refuses anyway). On the legacy
      // unsigned clients still in the wild — and on EVERY client while
      // `fygaro.checkout.enabled` is false, which is its default — the
      // reference is free text the PAYER types, so anyone could pay J$1, or $2
      // against the $10 minimum, with a stranger's username on it and have the
      // bank's own app tell that stranger we are holding a payment of theirs.
      //
      // Which is a price argument, not a blanket one, so the price decides:
      // REFUSAL_NEEDS_VERIFIED_REFERENCE exempts `over-limit`, whose trigger
      // costs the attacker MORE than the auto-credit limit and hands it to the
      // victim — the same self-defeating economics that leaves the `credited`
      // push ungated. Gating that one bought nothing and, with signed checkout
      // off, silenced the whole refusal half of this feature.
      if (
        REFUSAL_NOTIFIES_CUSTOMER[gate.reason] &&
        (authorizedIntent || !REFUSAL_NEEDS_VERIFIED_REFERENCE[gate.reason])
      ) {
        await sendFygaroTopupNotificationBestEffort({
          accountId,
          outcome: "heldForReview",
          // GROSS: what the card was actually charged, which is the number the
          // customer is looking at on their statement.
          amountCents: grossCents,
          currency,
        })
      }
      return res.status(200).json({ status: "recorded", credited: false })
    }

    // Credit path: serialize deliveries with a RELEASING lock and use the
    // audit row's Completed status as the processed marker. A crash between
    // here and the promotion releases the lock, so the next provider retry
    // re-runs this block — withPaymentIdempotency (keyed fygaro:<txId>) makes
    // the send itself exactly-once — instead of stranding a paid-but-
    // uncredited payment behind a consumed timelock. Distinct resource from
    // the lock withPaymentIdempotency takes internally (that one is scoped to
    // the sender wallet), so there is no nested-acquire collision.
    const creditAccountId = accountId
    const { fees } = gate
    const outcome = await LockService().lockPaymentIdempotencyKey(
      `fygaro-payment:${transactionId}` as IdempotencyKey,
      async () => {
        const priorCompletion = await readFygaroTopupCompletion(transactionId)
        if (priorCompletion.completed) {
          baseLogger.info({ transactionId }, "Duplicate Fygaro payment webhook")
          // Stamp before returning. `recordIntentOutcome` swallows its write
          // failures by design, so a first delivery that credited but failed to
          // stamp would leave every retry short-circuiting here — and the
          // customer polling "processing" until the record expires, for money
          // that is already in their wallet. Re-stamping an outcome that is
          // already there is a no-op write of the same value.
          //
          // The net comes off the COMPLETED ROW first, and only falls back to
          // this delivery's recomputed `fees.netCents` when the row carries no
          // figure. `fees` is derived from inputs that can legitimately differ
          // between deliveries — `getFlashFeeDiscountPercent` is fail-open to 0
          // and `getFygaroSettings` is a 60s cache over an operator-editable
          // doctype — so a whitelist read that fails on the retry would
          // recompute a SMALLER net than the one actually credited. The store's
          // merge prefers the incoming value, so that wrong number would
          // overwrite the right one and show the customer $96.50 CREDITED for
          // $99.00 that is in their wallet.
          await recordOutcome({
            state: "credited",
            netAmountCents: priorCompletion.netAmountCents ?? fees.netCents,
          })
          return { code: 200, body: { status: "already_processed" } }
        }

        const creditResult = await creditFygaroTopup({
          recipientAccountId: creditAccountId,
          amountCents: fees.netCents,
          transactionId,
        })
        if (creditResult instanceof FygaroCreditError) {
          baseLogger.error(
            { error: creditResult, transactionId, accountId: creditAccountId },
            "Fygaro payment recorded but auto-credit failed",
          )
          // Treasury-float exhaustion is an ops top-up problem, not a bug to
          // debug — raise a distinct critical (with its own static dedup key so
          // a run of exhausted credits collapses to one page) that names the
          // fix. Every other credit failure keeps the generic per-transaction
          // "manual credit needed" alert.
          const floatExhausted = creditResult.step === INSUFFICIENT_TREASURY_FLOAT_STEP
          alertBridge({
            dedupKey: floatExhausted
              ? generateDedupKey.fygaroFloatExhausted()
              : generateDedupKey.fygaroCreditFailed(transactionId),
            source: "fygaro-webhook",
            severity: "critical",
            title: floatExhausted
              ? "Fygaro treasury float EXHAUSTED — top up bankowner immediately"
              : "Fygaro auto-credit failed — manual credit needed",
            detail: `${creditResult.step}: ${creditResult.message}`,
            context: {
              transaction_id: transactionId,
              account_id: creditAccountId,
              amount: String(payload.amount),
            },
          })
          notifyOpsEvent({
            flow: "deposit",
            phase: "failed",
            status: "failed",
            step: `credit:${creditResult.step}`,
            error: creditResult.constructor.name,
            accountId: creditAccountId,
            amount: { value: String(payload.amount), currency },
            meta: { provider: "Fygaro", transactionId, username: username ?? "" },
          })
          // The payment IS recorded and the row stays Fiat Received. A failed
          // send is not cached, so a provider retry re-attempts the credit
          // (self-healing for transient failures); ops has the critical alert
          // for the deterministic ones.
          //
          // Release the HOLD but not the record. The ERPNext row already counts
          // this payment towards the daily cap (Fiat Received rows are summed),
          // so leaving the reservation up as well double-counts one payment:
          // $50 paid on a $125 cap would read as $100 spent and refuse the
          // customer's next $50 for the rest of the JWT window — a second
          // failure stacked on an already-failed credit. The record survives so
          // the manual credit this alert asks for still has its cross-check,
          // and so a provider retry (which this branch invites) can still
          // verify the payment.
          await releaseAuthorizedHold()
          // Deliberately NOT stamped with a failure_reason, unlike the
          // record-only path above. A failed credit is not terminal — this
          // branch exists to invite a provider retry — so the payment is still
          // in flight and must keep counting against the allowance. Marking it
          // uncredited would drop it out of the sum while a retry is pending
          // and let the customer authorise against allowance that is about to
          // be spent.
          await recordOutcome({ state: "failed", reason: "credit-failed" })

          // The one terminal outcome this notification exists for: money
          // captured, credit FAILED. Ops has a CRITICAL asking them to credit
          // it by hand and this response is a 200, so Fygaro stops retrying —
          // without this push the customer is silent forever, while someone
          // refused by the far more benign `under-minimum` gets told. The copy
          // ("completing it manually") is literally what the alert asks ops to
          // do. Currency is USD by construction here: the gate refuses non-USD
          // long before the credit path. Repeats on any provider retry that
          // re-attempts and re-fails the credit — same cadence as the ops-feed
          // line above, and each one is a fresh true statement.
          await sendFygaroTopupNotificationBestEffort({
            accountId: creditAccountId,
            outcome: "heldForReview",
            amountCents: fees.grossCents,
            currency,
          })
          return { code: 200, body: { status: "recorded", credited: false } }
        }

        // Contract with the admin fee-breakdown view: on a credited (Completed)
        // row every fee MUST be an explicit string, including "0.00" for a
        // zero-rate promo — `centsToDollars` never returns undefined. The admin
        // renders a missing fee as "Pending", which is correct only for an
        // uncredited (Fiat Received) row; never omit these here.
        const completeResult = await completeFygaroTopup({
          transactionId,
          accountId: creditAccountId,
          walletId: creditResult.walletId,
          amount: String(payload.amount),
          currency,
          initialAmount: centsToDollars(fees.grossCents),
          processorFee: centsToDollars(fees.processorFeeCents),
          flashFee: centsToDollars(fees.flashFeeCents),
          finalAmount: centsToDollars(fees.netCents),
          rawPayload: req.body,
        })
        if (completeResult instanceof Error) {
          // The money moved; only the audit promotion failed. Alert, don't
          // fail: the row stays Fiat Received, so a provider retry replays
          // the cached send result and re-attempts this promotion.
          alertBridge({
            dedupKey: generateDedupKey.erpnextFygaroAudit(transactionId),
            source: "erpnext-audit",
            severity: "warning",
            title: "Fygaro credit succeeded but ERPNext promotion failed",
            detail: completeResult.message,
            context: { transaction_id: transactionId },
          })
        }

        await recordOutcome({ state: "credited", netAmountCents: fees.netCents })

        notifyOpsEvent({
          flow: "deposit",
          phase: "succeeded",
          status: "success",
          accountId: creditAccountId,
          amount: { value: String(payload.amount), currency },
          meta: {
            provider: "Fygaro",
            transactionId,
            username: username ?? "",
            creditStatus: creditResult.status,
            net: centsToDollars(fees.netCents),
          },
        })

        // The money moved: the authorisation is spent. Not done on the credit-
        // FAILURE branch above, which is deliberately retryable.
        await redeemIntent()

        // The app told this customer "we'll let you know as soon as it lands".
        // A credit can outlive the screen — the transient paths deliberately
        // 500 so Fygaro retries — so this is what makes that sentence true.
        // Best-effort by construction: the money has already moved, and a
        // failed push must never put a delivered credit back into the retry
        // loop.
        // Awaited, matching the Bridge deposit path: the helper swallows every
        // failure internally, so awaiting cannot fail the credit, and NOT
        // awaiting would leave a dangling promise that a recycled pod can drop
        // — losing exactly the notification the app told the customer to expect.
        // Sequenced AFTER redeemIntent deliberately: a pod recycle during the
        // FCM round trip would otherwise leave the authorisation unconsumed, so
        // its hold keeps sitting on the daily allowance that the (already
        // promoted) ERPNext row counts too — double-counting one payment and
        // refusing the customer's next top-up with `daily-limit-exceeded`.
        // Costs the push nothing: `consumeIntent` reports failure by return
        // value, never a throw, so it cannot skip what follows it.
        // ONCE PER PAYMENT, and keyed on the TRANSACTION.
        //
        // This block is deliberately re-enterable: the Completed row is the
        // processed marker, and it is exactly what is missing after the
        // promotion failure alerted on above (money in the wallet, row still
        // Fiat Received), as it also is whenever `readFygaroTopupCompletion`
        // degrades to "not completed" on a transient lookup. Delivery 2 then
        // replays the cached send and arrives here for a top-up already paid.
        // A second "+$9.01 added" on a payments app's lock screen reads as a
        // second charge, and unlike a stale status screen it cannot be walked
        // back.
        //
        // The non-releasing timelock under its own key is the marker that
        // survives all of it. NOT the intent: `authorizedIntent` is undefined
        // for every payment whose custom_reference is a bare username — the
        // legacy shape, and the only shape in production while signed checkout
        // is off — so an intent-keyed guard protects nobody on the traffic that
        // actually exists. Its own key, because the record-only path's
        // `fygaro-payment:` lock is never taken on the credit path.
        const pushClaim = await LockService().lockIdempotencyKey(
          `fygaro-credit-push:${transactionId}` as IdempotencyKey,
        )
        if (pushClaim instanceof Error) {
          baseLogger.info(
            { transactionId },
            "Fygaro credit already announced to the customer — not re-announcing",
          )
        } else {
          await sendFygaroTopupNotificationBestEffort({
            accountId: creditAccountId,
            // `pending` gets its OWN phrase rather than the credited one or
            // nothing at all. Looked up in OUTCOME_BY_CREDIT_STATUS (above)
            // rather than branched on inline, so a third send status cannot
            // silently inherit either claim.
            outcome: OUTCOME_BY_CREDIT_STATUS[creditResult.status],
            // NET: what actually landed in the wallet (or is on its way to
            // it). Naming the gross would overstate the balance change by the
            // fees.
            amountCents: fees.netCents,
            currency,
          })
        }

        return { code: 200, body: { status: "success", credited: true } }
      },
    )
    if (outcome instanceof ResourceAttemptsLockServiceError) {
      // Another delivery of this payment holds the credit lock right now.
      baseLogger.info({ transactionId }, "Fygaro payment already being processed")
      return res.status(200).json({ status: "already_processing" })
    }
    if (outcome instanceof Error) {
      // Any other lock error means redlock swallowed a throw from inside the
      // credit block (UnknownLockServiceError). Rethrow so the catch-all
      // below returns 500 + critical alert and Fygaro retries, instead of
      // acking a stranded payment as "already_processing".
      throw outcome
    }
    return res.status(outcome.code).json(outcome.body)
  } catch (error) {
    baseLogger.error({ error, transactionId }, "Error processing Fygaro payment webhook")
    alertBridge({
      dedupKey: generateDedupKey.fygaroWebhookPayment(transactionId),
      source: "fygaro-webhook",
      severity: "critical",
      title: "Fygaro payment webhook processing error",
      detail: error instanceof Error ? error.message : String(error),
      context: { transaction_id: transactionId },
    })
    notifyOpsEvent({
      flow: "deposit",
      phase: "failed",
      status: "failed",
      step: "exception",
      error: error instanceof Error ? error.constructor.name : String(error),
      meta: { provider: "Fygaro", transactionId },
    })
    return res.status(500).json({ error: "Internal server error" })
  }
}
