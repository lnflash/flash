import { addWalletIfNonexistent, updateDefaultWalletId } from "@app/accounts"
import { getBalanceForWallet } from "@app/wallets"
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

type RuntimeServiceDependencies = {
  now?: () => Date
  addWalletIfNonexistent?: typeof addWalletIfNonexistent
  updateDefaultWalletId?: typeof updateDefaultWalletId
  getBalanceForWallet?: typeof getBalanceForWallet
  createInvoice?: typeof Ibex.addInvoice
  createNoAmountInvoice?: typeof Ibex.addInvoice
  payInvoice?: typeof Ibex.payInvoice
  accountsRepo?: Pick<ReturnType<typeof AccountsRepository>, "findById">
  getTreasuryWalletId?: () => Promise<WalletId | ApplicationError>
}

const isUsdAmount = (amount: unknown): amount is USDAmount => amount instanceof USDAmount
const isUsdtAmount = (amount: unknown): amount is USDTAmount =>
  amount instanceof USDTAmount

const ibexInvoiceToDomainInvoice = (response: Awaited<ReturnType<typeof Ibex.addInvoice>>) => {
  if (response instanceof Error) return response

  const invoiceString = response.invoice?.bolt11
  if (!invoiceString) return new UnexpectedIbexResponse("Could not find invoice.")

  const decodedInvoice = decodeInvoice(invoiceString)
  if (decodedInvoice instanceof Error) return decodedInvoice

  return decodedInvoice
}

export const createCashWalletMigrationRuntimeServices = (
  deps: RuntimeServiceDependencies = {},
) => {
  const addWallet = deps.addWalletIfNonexistent ?? addWalletIfNonexistent
  const updateDefaultWallet = deps.updateDefaultWalletId ?? updateDefaultWalletId
  const balanceForWallet = deps.getBalanceForWallet ?? getBalanceForWallet
  const invoiceForRecipient = deps.createInvoice ?? Ibex.addInvoice
  const noAmountInvoiceForRecipient = deps.createNoAmountInvoice ?? Ibex.addInvoice
  const payInvoice = deps.payInvoice ?? Ibex.payInvoice
  const accountsRepo = deps.accountsRepo ?? AccountsRepository()

  return {
    now: deps.now ?? (() => new Date()),
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
        const balance = await balanceForWallet({
          walletId: migration.legacyUsdWalletId,
          currency: WalletCurrency.Usd,
        })
        if (balance instanceof Error) return balance
        if (!isUsdAmount(balance)) {
          return new InvalidCashWalletCutoverAmountError("Expected USD balance")
        }
        return balance.asCents()
      },
      readDestinationBalanceUsdtMicros: async (
        migration: CashWalletMigration,
      ): Promise<string | ApplicationError> => {
        const balance = await balanceForWallet({
          walletId: migration.destinationUsdtWalletId,
          currency: WalletCurrency.Usdt,
        })
        if (balance instanceof Error) return balance
        if (!isUsdtAmount(balance)) {
          return new InvalidCashWalletCutoverAmountError("Expected USDT balance")
        }
        return balance.asSmallestUnits()
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

        return invoiceForRecipient({
          accountId: recipientWalletId as IbexAccountId,
          amount: usdtAmount,
          memo,
          expiration: CUTOVER_IBEX_INVOICE_EXPIRATION_SECONDS as Seconds,
        }).then(ibexInvoiceToDomainInvoice)
      },
      createNoAmountInvoice: ({
        recipientWalletId,
        memo,
      }: {
        recipientWalletId: WalletId
        memo: string
      }) =>
        noAmountInvoiceForRecipient({
          accountId: recipientWalletId,
          amount: USDTAmount.ZERO,
          memo,
          expiration: CUTOVER_IBEX_INVOICE_EXPIRATION_SECONDS as Seconds,
        }).then(ibexInvoiceToDomainInvoice),
    },
    paymentService: {
      payInvoice: async ({
        senderWalletId,
        paymentRequest,
        senderAmountUsdCents,
      }: {
        senderWalletId: WalletId
        paymentRequest: string
        senderAmountUsdCents?: string
      }): Promise<{ transactionId: IbexTransactionId } | ApplicationError> => {
        const send =
          senderAmountUsdCents === undefined
            ? undefined
            : USDAmount.cents(senderAmountUsdCents)
        if (send instanceof Error) return send

        const payment = await payInvoice({
          accountId: senderWalletId as IbexAccountId,
          invoice: paymentRequest as Bolt11,
          send,
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
        const balance = await balanceForWallet({
          walletId: legacyUsdWalletId,
          currency: WalletCurrency.Usd,
        })
        if (balance instanceof Error) return balance
        if (!isUsdAmount(balance) || !balance.isZero()) {
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

        const currentBalance = await balanceForWallet({
          walletId: migration.destinationUsdtWalletId,
          currency: WalletCurrency.Usdt,
        })
        if (currentBalance instanceof Error) return currentBalance
        if (!isUsdtAmount(currentBalance)) {
          return new InvalidCashWalletCutoverAmountError("Expected USDT balance")
        }

        return destinationShortfallUsdtMicros({
          targetUsdtMicros: migration.destinationAmountUsdtMicros,
          startingUsdtMicros: migration.destinationStartingBalanceUsdtMicros,
          currentUsdtMicros: currentBalance.asSmallestUnits(),
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
        const balance = await balanceForWallet({
          walletId: legacyUsdWalletId,
          currency: WalletCurrency.Usd,
        })
        if (balance instanceof Error) return balance
        if (!isUsdAmount(balance) || !balance.isZero()) {
          return new CashWalletMigrationFailedError("Legacy USD wallet is not zero")
        }
        return true
      },
    },
  }
}
