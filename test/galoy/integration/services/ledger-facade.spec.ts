import crypto from "crypto"

import { BtcWalletDescriptor, UsdWalletDescriptor, WalletCurrency } from "@domain/shared"
import { LedgerTransactionType } from "@domain/ledger"
import { UsdDisplayCurrency } from "@domain/fiat"
import { CouldNotFindError } from "@domain/errors"

import { LedgerService } from "@services/ledger"

import { createMandatoryUsers } from "test/galoy/helpers"
import {
  recordLnFailedPayment,
  recordLnFeeReimbursement,
  recordLnIntraLedgerPayment,
  recordLnTradeIntraAccountTxn,
  recordOnChainIntraLedgerPayment,
  recordOnChainTradeIntraAccountTxn,
  recordReceiveLnPayment,
  recordReceiveOnChainFeeReconciliation,
  recordReceiveOnChainPayment,
  recordSendLnPayment,
  recordSendOnChainPayment,
  recordWalletIdIntraLedgerPayment,
  recordWalletIdTradeIntraAccountTxn,
} from "test/galoy/helpers/ledger"

beforeAll(async () => {
  await createMandatoryUsers()
})

describe("Facade", () => {
  const receiveAmount = {
    usd: { amount: 100n, currency: WalletCurrency.Usd },
    btc: { amount: 200n, currency: WalletCurrency.Btc },
  }
  const sendAmount = {
    usd: { amount: 20n, currency: WalletCurrency.Usd },
    btc: { amount: 40n, currency: WalletCurrency.Btc },
  }
  const bankFee = {
    usd: { amount: 10n, currency: WalletCurrency.Usd },
    btc: { amount: 20n, currency: WalletCurrency.Btc },
  }

  const displayReceiveUsdAmounts = {
    amountDisplayCurrency: Number(receiveAmount.usd.amount) as DisplayCurrencyBaseAmount,
    feeDisplayCurrency: Number(bankFee.usd.amount) as DisplayCurrencyBaseAmount,
    displayCurrency: UsdDisplayCurrency,
  }

  const displayReceiveEurAmounts = {
    amountDisplayCurrency: 120 as DisplayCurrencyBaseAmount,
    feeDisplayCurrency: 12 as DisplayCurrencyBaseAmount,
    displayCurrency: "EUR" as DisplayCurrency,
  }

  const displaySendEurAmounts = {
    amountDisplayCurrency: 24 as DisplayCurrencyBaseAmount,
    feeDisplayCurrency: 12 as DisplayCurrencyBaseAmount,
    displayCurrency: "EUR" as DisplayCurrency,
  }

  describe("recordReceive", () => {
    it("recordReceiveLnPayment", async () => {
      const btcWalletDescriptor = BtcWalletDescriptor(crypto.randomUUID() as WalletId)

      const res = await recordReceiveLnPayment({
        walletDescriptor: btcWalletDescriptor,
        paymentAmount: receiveAmount,
        bankFee,
        displayAmounts: displayReceiveEurAmounts,
      })
      if (res instanceof Error) throw res

      const txns = await LedgerService().getTransactionsByWalletId(btcWalletDescriptor.id)
      if (txns instanceof Error) throw txns
      if (!(txns && txns.length)) throw new Error()
      const txn = txns[0]

      expect(txn.type).toBe(LedgerTransactionType.Invoice)
    })

    it("recordReceiveOnChainPayment", async () => {
      const btcWalletDescriptor = BtcWalletDescriptor(crypto.randomUUID() as WalletId)

      const res = await recordReceiveOnChainPayment({
        walletDescriptor: btcWalletDescriptor,
        paymentAmount: receiveAmount,
        bankFee,
        displayAmounts: displayReceiveEurAmounts,
      })
      if (res instanceof Error) throw res

      const txns = await LedgerService().getTransactionsByWalletId(btcWalletDescriptor.id)
      if (txns instanceof Error) throw txns
      if (!(txns && txns.length)) throw new Error()
      const txn = txns[0]

      expect(txn.type).toBe(LedgerTransactionType.OnchainReceipt)
    })

    it("recordLnFailedPayment", async () => {
      const btcWalletDescriptor = BtcWalletDescriptor(crypto.randomUUID() as WalletId)

      const res = await recordLnFailedPayment({
        walletDescriptor: btcWalletDescriptor,
        paymentAmount: receiveAmount,
        bankFee,
        displayAmounts: displayReceiveEurAmounts,
      })
      if (res instanceof Error) throw res

      const txns = await LedgerService().getTransactionsByWalletId(btcWalletDescriptor.id)
      if (txns instanceof Error) throw txns
      if (!(txns && txns.length)) throw new Error()
      const txn = txns[0]

      expect(txn.type).toBe(LedgerTransactionType.Payment)
    })

    it("recordLnFeeReimbursement", async () => {
      const btcWalletDescriptor = BtcWalletDescriptor(crypto.randomUUID() as WalletId)

      const res = await recordLnFeeReimbursement({
        walletDescriptor: btcWalletDescriptor,
        paymentAmount: receiveAmount,
        bankFee,
        displayAmounts: displayReceiveEurAmounts,
      })
      if (res instanceof Error) throw res

      const txns = await LedgerService().getTransactionsByWalletId(btcWalletDescriptor.id)
      if (txns instanceof Error) throw txns
      if (!(txns && txns.length)) throw new Error()
      const txn = txns[0]

      expect(txn.type).toBe(LedgerTransactionType.LnFeeReimbursement)
    })
  })

  describe("recordSend", () => {
    it("recordSendLnPayment", async () => {
      const btcWalletDescriptor = BtcWalletDescriptor(crypto.randomUUID() as WalletId)

      const res = await recordSendLnPayment({
        walletDescriptor: btcWalletDescriptor,
        paymentAmount: sendAmount,
        bankFee,
        displayAmounts: displaySendEurAmounts,
      })
      if (res instanceof Error) throw res

      const txns = await LedgerService().getTransactionsByWalletId(btcWalletDescriptor.id)
      if (txns instanceof Error) throw txns
      if (!(txns && txns.length)) throw new Error()
      const txn = txns[0]

      expect(txn.type).toBe(LedgerTransactionType.Payment)
    })

    it("recordSendOnChainPayment", async () => {
      const btcWalletDescriptor = BtcWalletDescriptor(crypto.randomUUID() as WalletId)

      const res = await recordSendOnChainPayment({
        walletDescriptor: btcWalletDescriptor,
        paymentAmount: sendAmount,
        bankFee,
        displayAmounts: displaySendEurAmounts,
      })
      if (res instanceof Error) throw res

      const txns = await LedgerService().getTransactionsByWalletId(btcWalletDescriptor.id)
      if (txns instanceof Error) throw txns
      if (!(txns && txns.length)) throw new Error()
      const txn = txns[0]

      expect(txn.type).toBe(LedgerTransactionType.OnchainPayment)
    })
  })

  describe("recordIntraledger", () => {
    it("recordLnIntraLedgerPayment", async () => {
      const btcWalletDescriptor = BtcWalletDescriptor(crypto.randomUUID() as WalletId)
      const usdWalletDescriptor = UsdWalletDescriptor(crypto.randomUUID() as WalletId)

      const res = await recordLnIntraLedgerPayment({
        senderWalletDescriptor: btcWalletDescriptor,
        recipientWalletDescriptor: usdWalletDescriptor,
        paymentAmount: sendAmount,
        senderDisplayAmounts: {
          senderAmountDisplayCurrency: displaySendEurAmounts.amountDisplayCurrency,
          senderFeeDisplayCurrency: displaySendEurAmounts.feeDisplayCurrency,
          senderDisplayCurrency: displaySendEurAmounts.displayCurrency,
        },
        recipientDisplayAmounts: {
          recipientAmountDisplayCurrency: displayReceiveUsdAmounts.amountDisplayCurrency,
          recipientFeeDisplayCurrency: displayReceiveUsdAmounts.feeDisplayCurrency,
          recipientDisplayCurrency: displayReceiveUsdAmounts.displayCurrency,
        },
      })
      if (res instanceof Error) throw res

      const senderTxns = await LedgerService().getTransactionsByWalletId(
        btcWalletDescriptor.id,
      )
      if (senderTxns instanceof Error) throw senderTxns
      if (!(senderTxns && senderTxns.length)) throw new Error()
      const senderTxn = senderTxns[0]
      expect(senderTxn.type).toBe(LedgerTransactionType.LnIntraLedger)

      const recipientTxns = await LedgerService().getTransactionsByWalletId(
        usdWalletDescriptor.id,
      )
      if (recipientTxns instanceof Error) throw recipientTxns
      if (!(recipientTxns && recipientTxns.length)) throw new Error()
      const recipientTxn = recipientTxns[0]
      expect(recipientTxn.type).toBe(LedgerTransactionType.LnIntraLedger)
    })

    it("recordWalletIdIntraLedgerPayment", async () => {
      const btcWalletDescriptor = BtcWalletDescriptor(crypto.randomUUID() as WalletId)
      const usdWalletDescriptor = UsdWalletDescriptor(crypto.randomUUID() as WalletId)

      const res = await recordWalletIdIntraLedgerPayment({
        senderWalletDescriptor: btcWalletDescriptor,
        recipientWalletDescriptor: usdWalletDescriptor,
        paymentAmount: sendAmount,
        senderDisplayAmounts: {
          senderAmountDisplayCurrency: displaySendEurAmounts.amountDisplayCurrency,
          senderFeeDisplayCurrency: displaySendEurAmounts.feeDisplayCurrency,
          senderDisplayCurrency: displaySendEurAmounts.displayCurrency,
        },
        recipientDisplayAmounts: {
          recipientAmountDisplayCurrency: displayReceiveUsdAmounts.amountDisplayCurrency,
          recipientFeeDisplayCurrency: displayReceiveUsdAmounts.feeDisplayCurrency,
          recipientDisplayCurrency: displayReceiveUsdAmounts.displayCurrency,
        },
      })
      if (res instanceof Error) throw res

      const senderTxns = await LedgerService().getTransactionsByWalletId(
        btcWalletDescriptor.id,
      )
      if (senderTxns instanceof Error) throw senderTxns
      if (!(senderTxns && senderTxns.length)) throw new Error()
      const senderTxn = senderTxns[0]
      expect(senderTxn.type).toBe(LedgerTransactionType.IntraLedger)

      const recipientTxns = await LedgerService().getTransactionsByWalletId(
        usdWalletDescriptor.id,
      )
      if (recipientTxns instanceof Error) throw recipientTxns
      if (!(recipientTxns && recipientTxns.length)) throw new Error()
      const recipientTxn = recipientTxns[0]
      expect(recipientTxn.type).toBe(LedgerTransactionType.IntraLedger)
    })

    it("recordOnChainIntraLedgerPayment", async () => {
      const btcWalletDescriptor = BtcWalletDescriptor(crypto.randomUUID() as WalletId)
      const usdWalletDescriptor = UsdWalletDescriptor(crypto.randomUUID() as WalletId)

      const res = await recordOnChainIntraLedgerPayment({
        senderWalletDescriptor: btcWalletDescriptor,
        recipientWalletDescriptor: usdWalletDescriptor,
        paymentAmount: sendAmount,
        senderDisplayAmounts: {
          senderAmountDisplayCurrency: displaySendEurAmounts.amountDisplayCurrency,
          senderFeeDisplayCurrency: displaySendEurAmounts.feeDisplayCurrency,
          senderDisplayCurrency: displaySendEurAmounts.displayCurrency,
        },
        recipientDisplayAmounts: {
          recipientAmountDisplayCurrency: displayReceiveUsdAmounts.amountDisplayCurrency,
          recipientFeeDisplayCurrency: displayReceiveUsdAmounts.feeDisplayCurrency,
          recipientDisplayCurrency: displayReceiveUsdAmounts.displayCurrency,
        },
      })
      if (res instanceof Error) throw res

      const senderTxns = await LedgerService().getTransactionsByWalletId(
        btcWalletDescriptor.id,
      )
      if (senderTxns instanceof Error) throw senderTxns
      if (!(senderTxns && senderTxns.length)) throw new Error()
      const senderTxn = senderTxns[0]
      expect(senderTxn.type).toBe(LedgerTransactionType.OnchainIntraLedger)

      const recipientTxns = await LedgerService().getTransactionsByWalletId(
        usdWalletDescriptor.id,
      )
      if (recipientTxns instanceof Error) throw recipientTxns
      if (!(recipientTxns && recipientTxns.length)) throw new Error()
      const recipientTxn = recipientTxns[0]
      expect(recipientTxn.type).toBe(LedgerTransactionType.OnchainIntraLedger)
    })
  })

  describe("recordTradeIntraAccount", () => {
    it("recordLnTradeIntraAccountTxn", async () => {
      const btcWalletDescriptor = BtcWalletDescriptor(crypto.randomUUID() as WalletId)
      const usdWalletDescriptor = UsdWalletDescriptor(crypto.randomUUID() as WalletId)

      const res = await recordLnTradeIntraAccountTxn({
        senderWalletDescriptor: btcWalletDescriptor,
        recipientWalletDescriptor: usdWalletDescriptor,
        paymentAmount: sendAmount,
        senderDisplayAmounts: {
          senderAmountDisplayCurrency: displaySendEurAmounts.amountDisplayCurrency,
          senderFeeDisplayCurrency: displaySendEurAmounts.feeDisplayCurrency,
          senderDisplayCurrency: displaySendEurAmounts.displayCurrency,
        },
        recipientDisplayAmounts: {
          recipientAmountDisplayCurrency: displayReceiveUsdAmounts.amountDisplayCurrency,
          recipientFeeDisplayCurrency: displayReceiveUsdAmounts.feeDisplayCurrency,
          recipientDisplayCurrency: displayReceiveUsdAmounts.displayCurrency,
        },
      })
      if (res instanceof Error) throw res

      const senderTxns = await LedgerService().getTransactionsByWalletId(
        btcWalletDescriptor.id,
      )
      if (senderTxns instanceof Error) throw senderTxns
      if (!(senderTxns && senderTxns.length)) throw new Error()
      const senderTxn = senderTxns[0]
      expect(senderTxn.type).toBe(LedgerTransactionType.LnTradeIntraAccount)

      const recipientTxns = await LedgerService().getTransactionsByWalletId(
        usdWalletDescriptor.id,
      )
      if (recipientTxns instanceof Error) throw recipientTxns
      if (!(recipientTxns && recipientTxns.length)) throw new Error()
      const recipientTxn = recipientTxns[0]
      expect(recipientTxn.type).toBe(LedgerTransactionType.LnTradeIntraAccount)
    })

    it("recordWalletIdTradeIntraAccountTxn", async () => {
      const btcWalletDescriptor = BtcWalletDescriptor(crypto.randomUUID() as WalletId)
      const usdWalletDescriptor = UsdWalletDescriptor(crypto.randomUUID() as WalletId)

      const res = await recordWalletIdTradeIntraAccountTxn({
        senderWalletDescriptor: btcWalletDescriptor,
        recipientWalletDescriptor: usdWalletDescriptor,
        paymentAmount: sendAmount,
        senderDisplayAmounts: {
          senderAmountDisplayCurrency: displaySendEurAmounts.amountDisplayCurrency,
          senderFeeDisplayCurrency: displaySendEurAmounts.feeDisplayCurrency,
          senderDisplayCurrency: displaySendEurAmounts.displayCurrency,
        },
        recipientDisplayAmounts: {
          recipientAmountDisplayCurrency: displayReceiveUsdAmounts.amountDisplayCurrency,
          recipientFeeDisplayCurrency: displayReceiveUsdAmounts.feeDisplayCurrency,
          recipientDisplayCurrency: displayReceiveUsdAmounts.displayCurrency,
        },
      })
      if (res instanceof Error) throw res

      const senderTxns = await LedgerService().getTransactionsByWalletId(
        btcWalletDescriptor.id,
      )
      if (senderTxns instanceof Error) throw senderTxns
      if (!(senderTxns && senderTxns.length)) throw new Error()
      const senderTxn = senderTxns[0]
      expect(senderTxn.type).toBe(LedgerTransactionType.WalletIdTradeIntraAccount)

      const recipientTxns = await LedgerService().getTransactionsByWalletId(
        usdWalletDescriptor.id,
      )
      if (recipientTxns instanceof Error) throw recipientTxns
      if (!(recipientTxns && recipientTxns.length)) throw new Error()
      const recipientTxn = recipientTxns[0]
      expect(recipientTxn.type).toBe(LedgerTransactionType.WalletIdTradeIntraAccount)
    })

    it("recordOnChainTradeIntraAccountTxn", async () => {
      const btcWalletDescriptor = BtcWalletDescriptor(crypto.randomUUID() as WalletId)
      const usdWalletDescriptor = UsdWalletDescriptor(crypto.randomUUID() as WalletId)

      const res = await recordOnChainTradeIntraAccountTxn({
        senderWalletDescriptor: btcWalletDescriptor,
        recipientWalletDescriptor: usdWalletDescriptor,
        paymentAmount: sendAmount,
        senderDisplayAmounts: {
          senderAmountDisplayCurrency: displaySendEurAmounts.amountDisplayCurrency,
          senderFeeDisplayCurrency: displaySendEurAmounts.feeDisplayCurrency,
          senderDisplayCurrency: displaySendEurAmounts.displayCurrency,
        },
        recipientDisplayAmounts: {
          recipientAmountDisplayCurrency: displayReceiveUsdAmounts.amountDisplayCurrency,
          recipientFeeDisplayCurrency: displayReceiveUsdAmounts.feeDisplayCurrency,
          recipientDisplayCurrency: displayReceiveUsdAmounts.displayCurrency,
        },
      })
      if (res instanceof Error) throw res

      const senderTxns = await LedgerService().getTransactionsByWalletId(
        btcWalletDescriptor.id,
      )
      if (senderTxns instanceof Error) throw senderTxns
      if (!(senderTxns && senderTxns.length)) throw new Error()
      const senderTxn = senderTxns[0]
      expect(senderTxn.type).toBe(LedgerTransactionType.OnChainTradeIntraAccount)

      const recipientTxns = await LedgerService().getTransactionsByWalletId(
        usdWalletDescriptor.id,
      )
      if (recipientTxns instanceof Error) throw recipientTxns
      if (!(recipientTxns && recipientTxns.length)) throw new Error()
      const recipientTxn = recipientTxns[0]
      expect(recipientTxn.type).toBe(LedgerTransactionType.OnChainTradeIntraAccount)
    })
  })

  describe("recordReceiveOnChainFeeReconciliation", () => {
    it("recordReceiveOnChainFeeReconciliation", async () => {
      const lowerFee = { amount: 1000n, currency: WalletCurrency.Btc }
      const higherFee = { amount: 2100n, currency: WalletCurrency.Btc }

      const res = await recordReceiveOnChainFeeReconciliation({
        estimatedFee: lowerFee,
        actualFee: higherFee,
      })
      if (res instanceof Error) throw res

      const { transactionIds } = res
      expect(transactionIds).toHaveLength(2)

      const ledger = LedgerService()

      const tx0 = await ledger.getTransactionById(transactionIds[0])
      const tx1 = await ledger.getTransactionById(transactionIds[1])
      const liabilitiesTxn = [tx0, tx1].find(
        (tx): tx is LedgerTransaction<WalletCurrency> =>
          !(tx instanceof CouldNotFindError),
      )
      if (liabilitiesTxn === undefined) throw new Error("Could not find transaction")
      expect(liabilitiesTxn.type).toBe(LedgerTransactionType.OnchainPayment)
    })
  })
})
