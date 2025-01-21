import Ibex from "@services/ibex/client"
import { flash, alice } from "../../jest.setup"

import { UsdWalletDescriptor, WalletCurrency } from "@domain/shared"

import { LedgerService } from "@services/ledger"
import { Payments } from "@app"
import  { addInvoice, payInvoiceV2 }  from "test/flash/mocks/ibex"

// jest.mock("@services/ibex/client")
// let mockedIbex: jest.Mock

beforeAll(async () => {
  // mockedIbex = Ibex as jest.Mock 
  // console.log(`mockedIbex = ${mockedIbex}`)
  // mockedIbex.mockReturnValue({
  //   addInvoice: jest.fn().mockResolvedValue(addInvoice.response),
  //   payInvoiceV2: jest.fn().mockResolvedValue(payInvoiceV2.response)
  // })
  // // console.log(`mockedIbex after = ${mockedIbex.}`)
  // console.log(`mocked before: ${JSON.stringify(await Ibex().addInvoice({ accountId: flash.usdWalletD.id }))}`)
  // console.log(`mocked before: ${JSON.stringify(await Ibex().payInvoiceV2({ accountId: alice.usdWalletD.id, bolt11: addInvoice.response.invoice.bolt11 }))}`)
})

afterAll(async () => {
  // jest.clearAllMocks() 
})
    
describe("Ledger", () => {
  // const receiveAmount = {
  //   usd: { amount: 100n, currency: WalletCurrency.Usd },
  //   btc: { amount: 200n, currency: WalletCurrency.Btc },
  // }
  // const sendAmount = {
  //   usd: { amount: 100n, currency: WalletCurrency.Usd },
  //   btc: { amount: 200n, currency: WalletCurrency.Btc },
  //   // jmd: { amount: 300n, Currency: WalletCurrency. }
  // }
  // const bankFee = {
  //   usd: { amount: 2n, currency: WalletCurrency.Usd },
  //   btc: { amount: 4n, currency: WalletCurrency.Btc },
  // }

  // const displayReceiveUsdAmounts = {
  //   amountDisplayCurrency: Number(receiveAmount.usd.amount) as DisplayCurrencyBaseAmount,
  //   feeDisplayCurrency: Number(bankFee.usd.amount) as DisplayCurrencyBaseAmount,
  //   displayCurrency: "USD" as DisplayCurrency,
  // }

  describe("CashOut", () => {

    it("records Ibex & Rtgs transactions", async () => {
      const amount = { amount: 100n, currency: WalletCurrency.Usd }

      const res = await LedgerService().recordCashOut({
        userWalletD: alice.usdWalletD,
        paymentDetails: { // change this type to IbexResponse
          sentAmt: amount,
          receivedAmt: amount,
        },
        liability: {
          amount: 15582n,
          currency: "JMD"
        },
      })

      if (res instanceof Error) throw res

      const txns = await LedgerService().getTransactionsByWalletId(alice.usdWalletD.id)
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
          // transactionFee: amount<"JMD">
        }
      })
      if (settleResult instanceof Error) throw settleResult

      const settleTxns = await LedgerService().getTransactionsByWalletId(alice.usdWalletD.id)
      if (settleTxns instanceof Error) throw settleTxns
      expect(settleTxns && settleTxns.length).toBe(2)

      // Verify settled with user
      expect((await LedgerService().getTotalAccountsPayable()).amount).toBe(0n)
    })

    it.skip("record foreign exchange gain", async () => {
      throw new Error('Test not implemented');
    })
    it.skip("record foreign exchange loss", async () => {
      throw new Error('Test not implemented');
    })
  })
})