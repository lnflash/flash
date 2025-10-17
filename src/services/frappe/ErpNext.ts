import { CashoutDetails } from "@app/offers"
import { USDAmount } from "@domain/shared"
import { baseLogger } from "@services/logger"
import axios from "axios"
import { JournalEntryDraftError, JournalEntrySubmitError, JournalEntryTitleError, JournalEntryDeleteError } from "./errors"
import { FrappeConfig } from "@config"
import ValidOffer from "@app/offers/ValidOffer"

const erpUsd = (usd: USDAmount): number => Number(usd.asCents(2)) // Number(usd.asDollars(2))

class ErpNext {
  url: string
  headers: Record<string, string>

  constructor(url: string, creds: FrappeCredentials) {
    this.url = url
    this.headers = {
      "Content-Type": "application/json",
      "Authorization": `token ${creds.apiKey}:${creds.apiSecret}`,
    }
  }

  async draftCashout(
    offer: ValidOffer,
  ): Promise<LedgerJournal | JournalEntryDraftError> {
    const party = offer.account.erpParty
    if (!party) return new JournalEntryDraftError("Account missing erpParty field")
    const { ibexTrx, flash } = offer.details
    const { liability } = flash
    const flashFee = flash.fee // ibexTrx.usd.minus(liability.usd)
    const journalEntry = {
      doctype: "Journal Entry",
      company: "Flash",
      multi_currency: 1,
      posting_date: new Date().toISOString().split('T')[0],
      remark: `${JSON.stringify({ paymentHash: ibexTrx.invoice.paymentHash, userWalletId: ibexTrx.userAcct })}`,
      accounts: [
        {
          account: FrappeConfig.erpnext.accounts.ibex.operating,
          account_currency: "USD",
          debit_in_account_currency: erpUsd(ibexTrx.usd),
          debit: erpUsd(ibexTrx.usd),
          exchange_rate: 1,
        },
        {
          account: FrappeConfig.erpnext.accounts.cashout, 
          account_currency: "JMD",
          credit_in_account_currency: Number(liability.jmd.asCents(2)),
          credit: erpUsd(liability.usd),
          exchange_rate: erpUsd(liability.usd) / Number(liability.jmd.asCents(2)),
          party_type: "Supplier",
          party, 
        },
        {
          account: FrappeConfig.erpnext.accounts.serviceFees,
          account_currency: "USD",
          credit_in_account_currency: erpUsd(flashFee),
          credit: erpUsd(flashFee),
          exchange_rate: 1,
        }
      ]
    }

    try {
      const resp = await axios.post(
        `${this.url}/api/resource/Journal Entry`,
        journalEntry,
        { headers: this.headers },
      )
      const titleResp = this.updateTitle(resp.data.data.name, `Open cashout ${ibexTrx.invoice.paymentHash.substring(0, 5)}`)
      if (titleResp instanceof JournalEntryTitleError) {
        baseLogger.error({ err: titleResp }, "Error updating JE title in ERPNext")
      }

      return {
        journalId: resp.data.data.name,
        voided: false,
        transactionIds: [],
      } as LedgerJournal
    } catch (err) {
      baseLogger.error({ err, journalEntry }, "Error drafting JE in ERPNext")
      return new JournalEntryDraftError(err)
    }

  }

  private async updateTitle(jeName: string, title: string): Promise<any | JournalEntryTitleError> { 
    try {
      const resp = await axios.put(
        `${this.url}/api/resource/Journal Entry/${jeName}`,
        { title },
        { headers: this.headers }
      )
      return resp.data
    } catch (err) {
      return new JournalEntryTitleError(err)
    }
  }

  async submit(jeName: string): Promise<any | JournalEntrySubmitError> {
    try {
      const resp = await axios.put(
        `${this.url}/api/resource/Journal Entry/${jeName}`,
        { docstatus: 1 },  // docstatus: 1 means submitted
        { headers: this.headers }
      )
      return resp.data
    } catch (err) {
      baseLogger.error({ err }, "Error submitting JE in ERPNext")
      return new JournalEntrySubmitError(err)
    }
  }

  async delete(jeName: string): Promise<void | JournalEntryDeleteError> {
    try {
      await axios.delete(
        `${this.url}/api/resource/Journal Entry/${jeName}`,
        { headers: this.headers }
      )
    } catch (err) {
      baseLogger.error({ err, jeName }, "Error deleting JE in ERPNext")
      return new JournalEntryDeleteError(err)
    }
  }

}

export default new ErpNext(FrappeConfig.url, FrappeConfig.credentials)
