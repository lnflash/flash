import { addWalletIfNonexistent, updateDefaultWalletId } from "@app/accounts"
import { decodeInvoice } from "@domain/bitcoin/lightning"
import { InvalidWalletId } from "@domain/errors"
import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"
import { AccountsRepository } from "@services/mongoose"
import Ibex from "@services/ibex/client"
import { UnexpectedIbexResponse } from "@services/ibex/errors"
import { getFunderWalletId } from "@services/ledger/caching"

import {
  CashWalletMigrationFailedError,
  InvalidCashWalletCutoverAmountError,
  InvalidCashWalletMigrationTransitionError,
} from "./errors"
import { destinationShortfallUsdtMicros } from "./amount-conversion"

const CUTOVER_IBEX_INVOICE_EXPIRATION_SECONDS = 15 * 60
const CUTOVER_IBEX_RATE_LIMIT_RETRY_DELAY_MS = 60_000
const CUTOVER_IBEX_RATE_LIMIT_MAX_ATTEMPTS = 5

type SleepFn = (delayMs: number) => Promise<void>

type RuntimeServiceDependencies = {
  now?: () => Date
  addWalletIfNonexistent?: typeof addWalletIfNonexistent
  updateDefaultWalletId?: typeof updateDefaultWalletId
  getRawAccountDetails?: typeof Ibex.getRawAccountDetails
  createInvoice?: typeof Ibex.addInvoice
  createNoAmountInvoice?: typeof Ibex.addInvoice
  payInvoice?: typeof Ibex.payInvoice
  accountsRepo?: Pick<ReturnType<typeof AccountsRepository>, "findById">
  getTreasuryWalletId?: () => Promise<WalletId | ApplicationError>
  maxRateLimitAttempts?: number
  rateLimitRetryDelayMs?: number
  sleep?: SleepFn
}

const normalizeDecimalString = (amount: number | string): string =>
  (typeof amount === "number" ? amount.toFixed(12) : amount).replace(/\.?0+$/, "") || "0"

const decimalToScaledInteger = ({
  amount,
  scale,
  round = true,
}: {
  amount: number | string
  scale: number
  round?: boolean
}): string | InvalidCashWalletCutoverAmountError => {
  const normalized = normalizeDecimalString(amount)
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return new InvalidCashWalletCutoverAmountError(
      `Invalid non-negative decimal amount: ${normalized}`,
    )
  }

  const [whole, fraction = ""] = normalized.split(".")
  const scaleFactor = 10n ** BigInt(scale)
  const paddedFraction = `${fraction}${"0".repeat(scale + 1)}`.slice(0, scale + 1)
  const scaledFraction = paddedFraction.slice(0, scale)
  const roundingDigit = Number(paddedFraction[scale] ?? "0")
  const scaled =
    BigInt(whole) * scaleFactor + BigInt(scaledFraction === "" ? "0" : scaledFraction)

  return (scaled + (round && roundingDigit >= 5 ? 1n : 0n)).toString()
}

const scaledIntegerToDecimal = ({
  amount,
  scale,
}: {
  amount: string
  scale: number
}): string => {
  if (scale === 0) return amount

  const padded = amount.padStart(scale + 1, "0")
  const whole = padded.slice(0, -scale)
  const fraction = padded.slice(-scale).replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : whole
}

const ibexUsdDollarsToPreciseCents = (
  amount: number | string,
): string | InvalidCashWalletCutoverAmountError => {
  const dollarsScaledToEightDecimals = decimalToScaledInteger({
    amount,
    scale: 8,
    round: false,
  })
  if (dollarsScaledToEightDecimals instanceof Error) return dollarsScaledToEightDecimals

  return scaledIntegerToDecimal({
    amount: dollarsScaledToEightDecimals,
    scale: 6,
  })
}

const ibexMajorUnitsToUsdtMicros = (
  amount: number | string,
): string | InvalidCashWalletCutoverAmountError =>
  decimalToScaledInteger({ amount, scale: 6 })

const hasOnlySubMicroMajorUnitDust = (amount: number | string | undefined): boolean =>
  amount === undefined || Number(normalizeDecimalString(amount)) < 0.000001

const ibexInvoiceToDomainInvoice = (
  response: Awaited<ReturnType<typeof Ibex.addInvoice>>,
) => {
  if (response instanceof Error) return response

  const invoiceString = response.invoice?.bolt11
  if (!invoiceString) return new UnexpectedIbexResponse("Could not find invoice.")

  const decodedInvoice = decodeInvoice(invoiceString)
  if (decodedInvoice instanceof Error) return decodedInvoice

  return decodedInvoice
}

const sleep: SleepFn = (delayMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, delayMs))

const errorMessage = (error: Error): string => error.message || String(error)

const isIbexRateLimitError = (error: Error): boolean =>
  errorMessage(error).toLowerCase().includes("too many requests")

const withIbexRateLimitRetry = async <T>({
  operation,
  maxAttempts,
  retryDelayMs,
  sleepFn,
}: {
  operation: () => Promise<T>
  maxAttempts: number
  retryDelayMs: number
  sleepFn: SleepFn
}): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    const result = await operation()

    if (
      !(result instanceof Error) ||
      !isIbexRateLimitError(result) ||
      attempt >= maxAttempts
    ) {
      return result
    }

    await sleepFn(retryDelayMs)
  }
}

export const createCashWalletMigrationRuntimeServices = (
  deps: RuntimeServiceDependencies = {},
) => {
  const addWallet = deps.addWalletIfNonexistent ?? addWalletIfNonexistent
  const updateDefaultWallet = deps.updateDefaultWalletId ?? updateDefaultWalletId
  const rawAccountDetails = deps.getRawAccountDetails ?? Ibex.getRawAccountDetails
  const invoiceForRecipient = deps.createInvoice ?? Ibex.addInvoice
  const noAmountInvoiceForRecipient = deps.createNoAmountInvoice ?? Ibex.addInvoice
  const payInvoice = deps.payInvoice ?? Ibex.payInvoice
  const accountsRepo = deps.accountsRepo ?? AccountsRepository()
  const rateLimitRetry = {
    maxAttempts: Math.max(
      1,
      deps.maxRateLimitAttempts ?? CUTOVER_IBEX_RATE_LIMIT_MAX_ATTEMPTS,
    ),
    retryDelayMs: deps.rateLimitRetryDelayMs ?? CUTOVER_IBEX_RATE_LIMIT_RETRY_DELAY_MS,
    sleepFn: deps.sleep ?? sleep,
  }

  return {
    now: deps.now ?? (() => new Date()),
    accountReader: {
      // Rollback (ENG-401): read the live default wallet so pointer restore
      // is a no-op when the account never flipped (or was already restored).
      getDefaultWalletId: async (
        accountId: AccountId,
      ): Promise<WalletId | ApplicationError> => {
        const account = await accountsRepo.findById(accountId)
        if (account instanceof Error) return account
        return account.defaultWalletId
      },
    },
    provisioningService: {
      ensureDestinationWallet: async ({
        accountId,
        destinationUsdtWalletId,
      }: {
        accountId: AccountId
        destinationUsdtWalletId: WalletId
      }): Promise<true | ApplicationError> => {
        const wallet = await addWallet({
          accountId,
          type: WalletType.Checking,
          currency: WalletCurrency.Usdt,
        })
        if (wallet instanceof Error) return wallet
        if (wallet.id !== destinationUsdtWalletId) return new InvalidWalletId()
        return true
      },
    },
    balanceReader: {
      readSourceBalanceUsdCents: async (
        migration: CashWalletMigration,
      ): Promise<string | ApplicationError> => {
        const account = await rawAccountDetails(
          migration.legacyUsdWalletId as IbexAccountId,
        )
        if (account instanceof Error) return account
        return ibexUsdDollarsToPreciseCents(account.balance ?? 0)
      },
      readDestinationBalanceUsdtMicros: async (
        migration: CashWalletMigration,
      ): Promise<string | ApplicationError> => {
        const account = await rawAccountDetails(
          migration.destinationUsdtWalletId as IbexAccountId,
        )
        if (account instanceof Error) return account
        return ibexMajorUnitsToUsdtMicros(account.balance ?? 0)
      },
    },
    invoiceService: {
      createInvoice: ({
        recipientWalletId,
        amount,
        memo,
      }: {
        recipientWalletId: WalletId
        amount: string
        memo: string
      }) => {
        const usdtAmount = USDTAmount.smallestUnits(amount)
        if (usdtAmount instanceof Error) return Promise.resolve(usdtAmount)

        return withIbexRateLimitRetry({
          ...rateLimitRetry,
          operation: () =>
            invoiceForRecipient({
              accountId: recipientWalletId as IbexAccountId,
              amount: usdtAmount,
              memo,
              expiration: CUTOVER_IBEX_INVOICE_EXPIRATION_SECONDS as Seconds,
            }),
        }).then(ibexInvoiceToDomainInvoice)
      },
      createNoAmountInvoice: ({
        recipientWalletId,
        memo,
      }: {
        recipientWalletId: WalletId
        memo: string
      }) =>
        withIbexRateLimitRetry({
          ...rateLimitRetry,
          operation: () =>
            noAmountInvoiceForRecipient({
              accountId: recipientWalletId,
              amount: USDTAmount.ZERO,
              memo,
              expiration: CUTOVER_IBEX_INVOICE_EXPIRATION_SECONDS as Seconds,
            }),
        }).then(ibexInvoiceToDomainInvoice),
    },
    paymentService: {
      payInvoice: async ({
        senderWalletId,
        paymentRequest,
        senderAmountUsdCents,
        senderAmountUsdtMicros,
      }: {
        senderWalletId: WalletId
        paymentRequest: string
        senderAmountUsdCents?: string
        senderAmountUsdtMicros?: string
      }): Promise<{ transactionId: IbexTransactionId } | ApplicationError> => {
        if (senderAmountUsdCents !== undefined && senderAmountUsdtMicros !== undefined) {
          return new InvalidCashWalletCutoverAmountError(
            "Only one explicit sender amount can be provided",
          )
        }

        const send =
          senderAmountUsdCents !== undefined
            ? USDAmount.cents(senderAmountUsdCents)
            : senderAmountUsdtMicros !== undefined
              ? USDTAmount.smallestUnits(senderAmountUsdtMicros)
              : undefined
        if (send instanceof Error) return send

        const payment = await withIbexRateLimitRetry({
          ...rateLimitRetry,
          operation: () =>
            payInvoice({
              accountId: senderWalletId as IbexAccountId,
              invoice: paymentRequest as Bolt11,
              send,
            }),
        })
        if (payment instanceof Error) return payment

        const transactionId = payment.transaction?.id
        if (!transactionId) {
          return new UnexpectedIbexResponse("Payment transaction id not found")
        }
        return { transactionId: transactionId as IbexTransactionId }
      },
    },
    balanceVerifier: {
      verifyBalanceMove: async ({
        legacyUsdWalletId,
      }: {
        legacyUsdWalletId: WalletId
      }): Promise<true | ApplicationError> => {
        const account = await rawAccountDetails(legacyUsdWalletId as IbexAccountId)
        if (account instanceof Error) return account
        if (!hasOnlySubMicroMajorUnitDust(account.balance)) {
          return new CashWalletMigrationFailedError("Legacy USD wallet is not zero")
        }
        return true
      },
    },
    feeService: {
      readFeeAmountUsdtMicros: async (
        migration: CashWalletMigration,
      ): Promise<string | ApplicationError> => {
        if (migration.balanceMovePaymentTransactionId === undefined) {
          return new InvalidCashWalletMigrationTransitionError(
            "balanceMovePaymentTransactionId is required before reading fee amount",
          )
        }

        if (migration.destinationAmountUsdtMicros === undefined) {
          return new InvalidCashWalletMigrationTransitionError(
            "destinationAmountUsdtMicros is required before reading fee amount",
          )
        }

        if (migration.destinationStartingBalanceUsdtMicros === undefined) {
          return new InvalidCashWalletMigrationTransitionError(
            "destinationStartingBalanceUsdtMicros is required before reading fee amount",
          )
        }

        const currentAccount = await rawAccountDetails(
          migration.destinationUsdtWalletId as IbexAccountId,
        )
        if (currentAccount instanceof Error) return currentAccount

        const currentUsdtMicros = ibexMajorUnitsToUsdtMicros(currentAccount.balance ?? 0)
        if (currentUsdtMicros instanceof Error) return currentUsdtMicros

        return destinationShortfallUsdtMicros({
          targetUsdtMicros: migration.destinationAmountUsdtMicros,
          startingUsdtMicros: migration.destinationStartingBalanceUsdtMicros,
          currentUsdtMicros,
        })
      },
    },
    treasuryService: {
      getTreasuryWalletId: deps.getTreasuryWalletId ?? getFunderWalletId,
    },
    pointerService: {
      flipDefaultWallet: async ({
        accountId,
        destinationWalletId,
      }: {
        accountId: AccountId
        destinationWalletId: WalletId
      }): Promise<{ previousDefaultWalletId: WalletId } | ApplicationError> => {
        const account = await accountsRepo.findById(accountId)
        if (account instanceof Error) return account

        const previousDefaultWalletId = account.defaultWalletId
        const updated = await updateDefaultWallet({
          accountId,
          walletId: destinationWalletId,
        })
        if (updated instanceof Error) return updated

        return { previousDefaultWalletId }
      },
    },
    legacyWalletVerifier: {
      verifyLegacyWalletZero: async ({
        legacyUsdWalletId,
      }: {
        legacyUsdWalletId: WalletId
      }): Promise<true | ApplicationError> => {
        const account = await rawAccountDetails(legacyUsdWalletId as IbexAccountId)
        if (account instanceof Error) return account
        if (!hasOnlySubMicroMajorUnitDust(account.balance)) {
          return new CashWalletMigrationFailedError("Legacy USD wallet is not zero")
        }
        return true
      },
    },
  }
}
