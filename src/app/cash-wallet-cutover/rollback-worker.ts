import { assertCanTransition, ROLLBACKABLE_STATUSES } from "./state-machine"
import { legacyShortfallUsdtMicros } from "./amount-conversion"
import { isInvoicePaymentRequestStale } from "./worker"
import {
  CashWalletMigrationFailedError,
  InvalidCashWalletMigrationTransitionError,
} from "./errors"

// One US cent, in USDT micros. Reverse moves and treasury top-ups are LN
// payments whose received amount can differ from the sent amount by routing
// dust; anything at or under a cent is treated as whole.
const ROLLBACK_SHORTFALL_TOLERANCE_USDT_MICROS = 10_000n

type CashWalletMigrationTransitionRepository = {
  transitionMigration(args: {
    id: string
    from: CashWalletMigrationStatus
    to: CashWalletMigrationStatus
    cutoverVersion: number
    runId: string
    patch?: Partial<CashWalletMigration>
  }): Promise<CashWalletMigration | RepositoryError>
}

type CashWalletRollbackServices = {
  now(): Date
  accountReader: {
    getDefaultWalletId(accountId: AccountId): Promise<WalletId | ApplicationError>
  }
  pointerService: {
    flipDefaultWallet(args: {
      accountId: AccountId
      destinationWalletId: WalletId
    }): Promise<{ previousDefaultWalletId: WalletId } | ApplicationError>
  }
  balanceReader: {
    readSourceBalanceUsdCents(
      migration: CashWalletMigration,
    ): Promise<string | ApplicationError>
    readDestinationBalanceUsdtMicros(
      migration: CashWalletMigration,
    ): Promise<string | ApplicationError>
    readDestinationSpendableUsdtMicros(
      migration: CashWalletMigration,
    ): Promise<string | ApplicationError>
  }
  invoiceService: {
    createNoAmountInvoice(args: {
      recipientWalletId: WalletId
      memo: string
    }): Promise<LnInvoice | ApplicationError>
  }
  paymentService: {
    payInvoice(args: {
      senderWalletId: WalletId
      paymentRequest: string
      senderAmountUsdCents?: string
      senderAmountUsdtMicros?: string
    }): Promise<{ transactionId: IbexTransactionId } | ApplicationError>
  }
  treasuryService: {
    getTreasuryWalletId(): Promise<WalletId | ApplicationError>
  }
}

export const isRollbackableCashWalletMigrationStatus = (
  status: CashWalletMigrationStatus,
): boolean => ROLLBACKABLE_STATUSES.includes(status)

/**
 * Pull a migration into rollback (ENG-401). Idempotent at the caller level:
 * a migration already in `rollback_started` or `rolled_back` is not an error
 * to skip; this function itself enforces the state machine strictly.
 * `skipped_already_migrated` is deliberately not rollbackable — those
 * accounts were on USDT before the run and are left there.
 */
export const requestCashWalletMigrationRollback = async ({
  migration,
  migrationsRepo,
  requestedBy,
  reason,
  requestedAt,
}: {
  migration: CashWalletMigration
  migrationsRepo: CashWalletMigrationTransitionRepository
  requestedBy: string
  reason: string
  requestedAt: Date
}): Promise<CashWalletMigration | ApplicationError> => {
  const transition = assertCanTransition(migration.status, "rollback_started")
  if (transition instanceof Error) return transition

  return migrationsRepo.transitionMigration({
    id: migration.id,
    from: migration.status,
    to: "rollback_started",
    cutoverVersion: migration.cutoverVersion,
    runId: migration.runId,
    patch: {
      rollbackRequestedAt: requestedAt,
      rollbackRequestedBy: requestedBy,
      rollbackReason: reason,
      rollbackFromStatus: migration.status,
    },
  })
}

const patchRollbackProgress = ({
  migration,
  migrationsRepo,
  patch,
}: {
  migration: CashWalletMigration
  migrationsRepo: CashWalletMigrationTransitionRepository
  patch: Partial<CashWalletMigration>
}) =>
  migrationsRepo.transitionMigration({
    id: migration.id,
    from: "rollback_started",
    to: "rollback_started",
    cutoverVersion: migration.cutoverVersion,
    runId: migration.runId,
    patch,
  })

/**
 * Execute (or resume) the rollback of a single migration. Progress is
 * field-driven, mirroring the forward pipeline's field-presence guards, so a
 * crash at any point resumes idempotently:
 *
 *   1. restore the default-wallet pointer if it still points at USDT
 *   2. reverse the balance move (invoice on the legacy USD wallet, paid from
 *      the USDT wallet with the exact forward amount) — fails closed if the
 *      USDT balance no longer covers it
 *   3. treasury tops up any remaining USD shortfall vs the original balance
 *   4. verify the user is whole (within 1 cent of LN dust) and finalize
 *
 * Pre-money migrations (no forward payment ever sent) skip 2-3 and
 * short-circuit to `rolled_back`.
 */
export const executeCashWalletMigrationRollbackStep = async ({
  migration,
  migrationsRepo,
  services,
}: {
  migration: CashWalletMigration
  migrationsRepo: CashWalletMigrationTransitionRepository
  services: CashWalletRollbackServices
}): Promise<CashWalletMigration | ApplicationError> => {
  if (migration.status !== "rollback_started") {
    return new InvalidCashWalletMigrationTransitionError(
      `Rollback step requires status rollback_started, got: ${migration.status}`,
    )
  }

  let current = migration

  // 1. Pointer restore — only when the forward pipeline actually flipped the
  // pointer, evidenced by previousDefaultWalletId (the flip is the only
  // writer of that field). Pre-money migrations never flipped; if such an
  // account defaults to USDT it got there by other means (e.g. native
  // USDT-default signup) and the rollback must not touch it. The live
  // default is still checked so an already-restored pointer is a no-op.
  if (current.rollbackPointerRestoredAt === undefined) {
    if (current.previousDefaultWalletId !== undefined) {
      const defaultWalletId = await services.accountReader.getDefaultWalletId(
        current.accountId,
      )
      if (defaultWalletId instanceof Error) return defaultWalletId

      if (defaultWalletId === current.destinationUsdtWalletId) {
        const restored = await services.pointerService.flipDefaultWallet({
          accountId: current.accountId,
          destinationWalletId: current.previousDefaultWalletId,
        })
        if (restored instanceof Error) return restored
      }
    }

    const patched = await patchRollbackProgress({
      migration: current,
      migrationsRepo,
      patch: { rollbackPointerRestoredAt: services.now() },
    })
    if (patched instanceof Error) return patched
    current = patched
  }

  const forwardMovedFunds = current.balanceMovePaymentTransactionId !== undefined

  // 2. Reverse balance move.
  if (forwardMovedFunds && current.rollbackPaymentTransactionId === undefined) {
    if (current.destinationAmountUsdtMicros === undefined) {
      return new InvalidCashWalletMigrationTransitionError(
        "destinationAmountUsdtMicros is required to reverse a sent balance move",
      )
    }

    if (current.destinationAmountUsdtMicros !== "0") {
      // Reverse the ACTUAL spendable balance (floored), capped at the forward
      // amount — never the raw target. The USDT wallet legitimately holds
      // slightly less than target: the un-reimbursed forward routing fee plus
      // sub-micro rounding. Paying the target verbatim overspends → IBEX 400
      // (ENG-401). Reversing the spendable balance makes the user whole minus
      // that sub-cent dust. Fail closed only when the wallet is short by MORE
      // than tolerance — the signature of the user having spent USDT
      // post-cutover, which needs operator judgment.
      const target = BigInt(current.destinationAmountUsdtMicros)
      const spendableStr =
        await services.balanceReader.readDestinationSpendableUsdtMicros(current)
      if (spendableStr instanceof Error) return spendableStr
      const spendable = BigInt(spendableStr)

      const reverseAmount = spendable < target ? spendable : target
      const shortfall = target - reverseAmount
      if (shortfall > ROLLBACK_SHORTFALL_TOLERANCE_USDT_MICROS) {
        return new CashWalletMigrationFailedError(
          `USDT balance ${spendableStr} is short of reverse target ${target} by ${shortfall} micros (> tolerance) — likely spent post-cutover`,
        )
      }
      const reverseAmountStr = reverseAmount.toString()

      if (
        current.rollbackInvoicePaymentRequest === undefined ||
        isInvoicePaymentRequestStale({
          paymentRequest: current.rollbackInvoicePaymentRequest,
          now: services.now(),
        })
      ) {
        const invoice = await services.invoiceService.createNoAmountInvoice({
          recipientWalletId: current.legacyUsdWalletId,
          memo: `cwco-rb:${current.runId}:${current.id}:move`,
        })
        if (invoice instanceof Error) return invoice

        const patched = await patchRollbackProgress({
          migration: current,
          migrationsRepo,
          patch: {
            rollbackInvoicePaymentRequest: invoice.paymentRequest,
            rollbackInvoicePaymentHash: invoice.paymentHash,
          },
        })
        if (patched instanceof Error) return patched
        current = patched
      }

      if (current.rollbackInvoicePaymentRequest === undefined) {
        return new InvalidCashWalletMigrationTransitionError(
          "rollbackInvoicePaymentRequest is required before reverse payment sending",
        )
      }

      const payment = await services.paymentService.payInvoice({
        senderWalletId: current.destinationUsdtWalletId,
        paymentRequest: current.rollbackInvoicePaymentRequest,
        senderAmountUsdtMicros: reverseAmountStr,
      })
      if (payment instanceof Error) return payment

      const patched = await patchRollbackProgress({
        migration: current,
        migrationsRepo,
        patch: { rollbackPaymentTransactionId: payment.transactionId },
      })
      if (patched instanceof Error) return patched
      current = patched
    }
  }

  // 3 + 4. Shortfall top-up and verification — only meaningful when funds
  // moved forward (and therefore sourceBalanceUsdCents was recorded).
  if (forwardMovedFunds) {
    if (current.sourceBalanceUsdCents === undefined) {
      return new InvalidCashWalletMigrationTransitionError(
        "sourceBalanceUsdCents is required to verify a rollback",
      )
    }

    const currentUsdCents =
      await services.balanceReader.readSourceBalanceUsdCents(current)
    if (currentUsdCents instanceof Error) return currentUsdCents

    const shortfall = legacyShortfallUsdtMicros({
      sourceUsdCents: current.sourceBalanceUsdCents,
      currentUsdCents,
    })
    if (shortfall instanceof Error) return shortfall

    if (BigInt(shortfall) > ROLLBACK_SHORTFALL_TOLERANCE_USDT_MICROS) {
      if (current.rollbackShortfallPaymentTransactionId !== undefined) {
        // Treasury already topped up once and the user is still short more
        // than dust — never double-pay automatically.
        return new CashWalletMigrationFailedError(
          `Legacy wallet still short ${shortfall} USDT micros after treasury top-up`,
        )
      }

      const treasuryWalletId = await services.treasuryService.getTreasuryWalletId()
      if (treasuryWalletId instanceof Error) return treasuryWalletId

      if (
        current.rollbackShortfallInvoicePaymentRequest === undefined ||
        isInvoicePaymentRequestStale({
          paymentRequest: current.rollbackShortfallInvoicePaymentRequest,
          now: services.now(),
        })
      ) {
        const invoice = await services.invoiceService.createNoAmountInvoice({
          recipientWalletId: current.legacyUsdWalletId,
          memo: `cwco-rb:${current.runId}:${current.id}:shortfall`,
        })
        if (invoice instanceof Error) return invoice

        const patched = await patchRollbackProgress({
          migration: current,
          migrationsRepo,
          patch: {
            rollbackShortfallUsdtMicros: shortfall,
            rollbackShortfallInvoicePaymentRequest: invoice.paymentRequest,
            rollbackShortfallInvoicePaymentHash: invoice.paymentHash,
          },
        })
        if (patched instanceof Error) return patched
        current = patched
      }

      if (current.rollbackShortfallInvoicePaymentRequest === undefined) {
        return new InvalidCashWalletMigrationTransitionError(
          "rollbackShortfallInvoicePaymentRequest is required before shortfall payment",
        )
      }

      const payment = await services.paymentService.payInvoice({
        senderWalletId: treasuryWalletId,
        paymentRequest: current.rollbackShortfallInvoicePaymentRequest,
        senderAmountUsdtMicros: shortfall,
      })
      if (payment instanceof Error) return payment

      const patched = await patchRollbackProgress({
        migration: current,
        migrationsRepo,
        patch: { rollbackShortfallPaymentTransactionId: payment.transactionId },
      })
      if (patched instanceof Error) return patched

      // Leave in rollback_started; the next batch pass re-reads the balance
      // and finalizes (or fails closed if still short after the top-up).
      return patched
    }
  }

  return migrationsRepo.transitionMigration({
    id: current.id,
    from: "rollback_started",
    to: "rolled_back",
    cutoverVersion: current.cutoverVersion,
    runId: current.runId,
    patch: { rolledBackAt: services.now() },
  })
}
