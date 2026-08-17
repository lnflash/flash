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
  isFygaroTopupCompleted,
  sumFygaroTopupGrossCentsLast24h,
} from "@services/frappe/BridgeTransferRequestWriter"
import { alertBridge, generateDedupKey } from "@services/alerts"
import { notifyOpsEvent } from "@services/alerts/ops-events"

import {
  creditFygaroTopup,
  FygaroCreditError,
  INSUFFICIENT_TREASURY_FLOAT_STEP,
} from "../credit-topup"
import { getFygaroSettings } from "../fygaro-settings"
import { parseCustomReference } from "../../checkout"
import { consumeIntent, readIntent } from "../../checkout-intent-store"
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
    // Cross-check the payment against what the server authorised, when the
    // reference carries an intent. The signed JWT already prevents the customer
    // altering the amount, so a mismatch here means something on OUR side is
    // wrong — a signing bug, a stale intent, a replay — and quietly crediting a
    // payment we cannot account for is the failure this whole workstream is
    // about. A missing intent is NOT treated as a mismatch: it is the legacy
    // position (unverified), and the credit gate below still applies in full.
    //
    // The read is NON-DESTRUCTIVE. This handler answers 500 on the transient
    // stops below so the provider retries; consuming here would burn the
    // authorisation on a delivery that credited nothing, leaving the retry that
    // actually moves money — the one most worth verifying — with nothing to
    // check against. The intent is redeemed instead on the terminal paths
    // (`redeemIntent` below), which is also where its hold on the account's
    // daily allowance is released.
    let intentMismatch: string | undefined
    if (intentId) {
      const lookup = await readIntent(intentId)
      if (lookup.found) {
        const authorized = lookup.intent
        if (authorized.amountCents !== grossCents) {
          intentMismatch = `authorised ${authorized.amountCents}c, paid ${grossCents}c`
        } else if (accountId && authorized.accountId !== accountId) {
          intentMismatch = `authorised for account ${authorized.accountId}, paid as ${accountId}`
        }
      } else {
        baseLogger.info(
          { transactionId, intentId },
          "Fygaro payment references an intent that is expired, consumed or unknown",
        )
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
        if (await isFygaroTopupCompleted(transactionId)) {
          baseLogger.info({ transactionId }, "Duplicate Fygaro payment webhook")
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
