 import crypto from "crypto"

import { BtcWalletDescriptor, UsdWalletDescriptor, WalletCurrency } from "@domain/shared"
import { LedgerTransactionType } from "@domain/ledger"

import { LedgerService } from "@services/ledger"
import * as LedgerFacade from "@services/ledger/facade"

import { createMandatoryUsers } from "test/galoy/helpers"
import Currency from "@graphql/public/types/object/currency"

beforeAll(async () => {
  await createMandatoryUsers()
})
    
describe("Ledger", () => {
  const receiveAmount = {
    usd: { amount: 100n, currency: WalletCurrency.Usd },
    btc: { amount: 200n, currency: WalletCurrency.Btc },
  }
  const sendAmount = {
    usd: { amount: 100n, currency: WalletCurrency.Usd },
    btc: { amount: 200n, currency: WalletCurrency.Btc },
    // jmd: { amount: 300n, Currency: WalletCurrency. }
  }
  const bankFee = {
    usd: { amount: 2n, currency: WalletCurrency.Usd },
    btc: { amount: 4n, currency: WalletCurrency.Btc },
  }

  const displayReceiveUsdAmounts = {
    amountDisplayCurrency: Number(receiveAmount.usd.amount) as DisplayCurrencyBaseAmount,
    feeDisplayCurrency: Number(bankFee.usd.amount) as DisplayCurrencyBaseAmount,
    displayCurrency: "USD" as DisplayCurrency,
  }

  describe("recordCashOut", () => {
    it("records Ibex & Rtgs transactions", async () => {
      const usdWalletD = UsdWalletDescriptor(crypto.randomUUID() as WalletId)

      const res = await LedgerService().recordCashOut({
        userWalletD: usdWalletD,
        paymentDetails: {
          sentAmt: { amount: 100n, currency: WalletCurrency.Usd },
          receivedAmt: { amount: 100n, currency: WalletCurrency.Usd }
        },
        liability: {
          amount: 15582n,
          currency: "JMD"
        },
      })

      if (res instanceof Error) throw res

      const txns = await LedgerService().getTransactionsByWalletId(usdWalletD.id)
      if (txns instanceof Error) throw txns
      expect(txns && txns.length).toBe(1)
      expect(txns[0].type).toBe("ibex:invoice")

      const settleResult = await LedgerService().recordSettledCashOut({
        ledgerTrxid: txns[0].id,
        paymentDetails: {
          transactionId: "some-rtgs-trx-id",
          senderAccountId: "flash-rtgs-acct-id", // sample
          receiverAccountId: "user-rtgs-acct-id", // sample
          sent: { amount: 15582n, currency: "JMD" },
        }
      })
      if (settleResult instanceof Error) throw settleResult

      const settleTxns = await LedgerService().getTransactionsByWalletId(usdWalletD.id)
      if (settleTxns instanceof Error) throw txns
      expect(settleTxns && settleTxns.length).toBe(2)

      // Verify the book is balanced
      expect((await LedgerService().getTotalAccountsPayable()).amount).toBe(0n)
    })

    it("record foreign exchange gain", async () => {
      throw new Error('Test not implemented');
    })
    it("record foreign exchange loss", async () => {
      throw new Error('Test not implemented');
    })
  })
})