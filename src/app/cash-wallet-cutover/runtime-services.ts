import { addWalletIfNonexistent, updateDefaultWalletId } from "@app/accounts"
import { addInvoiceForRecipientForUsdWallet, getBalanceForWallet } from "@app/wallets"
import { InvalidWalletId } from "@domain/errors"
import { USDAmount, WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"
import { AccountsRepository } from "@services/mongoose"
import Ibex from "@services/ibex/client"
import { UnexpectedIbexResponse } from "@services/ibex/errors"

import {
  CashWalletMigrationFailedError,
  InvalidCashWalletCutoverAmountError,
  InvalidCashWalletMigrationTransitionError,
} from "./errors"

type RuntimeServiceDependencies = {
  now?: () => Date
  addWalletIfNonexistent?: typeof addWalletIfNonexistent
  updateDefaultWalletId?: typeof updateDefaultWalletId
  getBalanceForWallet?: typeof getBalanceForWallet
  createInvoice?: typeof addInvoiceForRecipientForUsdWallet
  payInvoice?: typeof Ibex.payInvoice
  getTransactionDetails?: typeof Ibex.getTransactionDetails
  accountsRepo?: Pick<ReturnType<typeof AccountsRepository>, "findById">
}

const isUsdAmount = (amount: unknown): amount is USDAmount => amount instanceof USDAmount

const feeAmountUsdCentsFromNumber = (
  feeAmount: number | undefined,
): string | InvalidCashWalletCutoverAmountError => {
  if (feeAmount === undefined || Number.isNaN(feeAmount) || feeAmount < 0) {
    return new InvalidCashWalletCutoverAmountError("Invalid fee amount")
  }
  return Math.ceil(feeAmount * 100).toString()
}

export const createCashWalletMigrationRuntimeServices = (
  deps: RuntimeServiceDependencies = {},
) => {
  const addWallet = deps.addWalletIfNonexistent ?? addWalletIfNonexistent
  const updateDefaultWallet = deps.updateDefaultWalletId ?? updateDefaultWalletId
  const balanceForWallet = deps.getBalanceForWallet ?? getBalanceForWallet
  const invoiceForRecipient = deps.createInvoice ?? addInvoiceForRecipientForUsdWallet
  const payInvoice = deps.payInvoice ?? Ibex.payInvoice
  const getTransactionDetails = deps.getTransactionDetails ?? Ibex.getTransactionDetails
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
      }) =>
        invoiceForRecipient({
          recipientWalletId,
          amount: amount as FractionalCentAmount,
          memo,
        }),
    },
    paymentService: {
      payInvoice: async ({
        senderWalletId,
        paymentRequest,
      }: {
        senderWalletId: WalletId
        paymentRequest: string
      }): Promise<{ transactionId: IbexTransactionId } | ApplicationError> => {
        const payment = await payInvoice({
          accountId: senderWalletId as IbexAccountId,
          invoice: paymentRequest as Bolt11,
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
      readFeeAmountUsdCents: async (
        migration: CashWalletMigration,
      ): Promise<string | ApplicationError> => {
        if (migration.balanceMovePaymentTransactionId === undefined) {
          return new InvalidCashWalletMigrationTransitionError(
            "balanceMovePaymentTransactionId is required before reading fee amount",
          )
        }

        const transaction = await getTransactionDetails(
          migration.balanceMovePaymentTransactionId,
        )
        if (transaction instanceof Error) return transaction

        return feeAmountUsdCentsFromNumber(transaction.networkFee ?? transaction.fee)
      },
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
