 import crypto from "crypto"

import { BtcWalletDescriptor, UsdWalletDescriptor, WalletCurrency } from "@domain/shared"
import { LedgerTransactionType } from "@domain/ledger"

import { LedgerService } from "@services/ledger"

import { createMandatoryUsers } from "test/galoy/helpers"
import {  
  recordSendOnChainPayment
} from "test/flash/helpers/ledger"

beforeAll(async () => {
  await createMandatoryUsers()
})
    
describe("Ledger", () => {
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
    displayCurrency: "USD" as DisplayCurrency,
  }

  describe("recordSendOnChainPayment", () => {
    it("successfully writes", async () => {
      const btcWalletDescriptor = BtcWalletDescriptor(crypto.randomUUID() as WalletId)

      const res = await recordSendOnChainPayment({
        walletDescriptor: btcWalletDescriptor,
        paymentAmount: sendAmount,
        bankFee,
        displayAmounts: displayReceiveUsdAmounts,
      })
      if (res instanceof Error) throw res

      const txns = await LedgerService().getTransactionsByWalletId(btcWalletDescriptor.id)
      if (txns instanceof Error) throw txns
      if (!(txns && txns.length)) throw new Error()
      const txn = txns[0]

      expect(txn.type).toBe(LedgerTransactionType.OnchainPayment)
    })
  })
})