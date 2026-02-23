import ValidOffer from "@app/offers/ValidOffer"
import { FrappeConfig } from "@config"
import { USDAmount, Validated } from "@domain/shared"
import { baseLogger } from "@services/logger"
import axios, { isAxiosError } from "axios"

import {
  JournalEntryDraftError,
  JournalEntrySubmitError,
  JournalEntryTitleError,
  JournalEntryDeleteError,
  UpgradeRequestCreateError,
  UpgradeRequestQueryError,
  BanksQueryError,
  SetDocTypeValueError,
} from "./errors"
import {
  AccountUpgradeRequest,
  RequestStatus,
} from "./models/AccountUpgradeRequest"
import { Bank } from "./models/Bank"

// Move to MoneyAmount
const erpUsd = (usd: USDAmount): number => Number(usd.asCents(2))

// poorly written but correct as is
const buildUpgradeRequestFilters = (filters: {
  username?: string
  status?: RequestStatus
}): string => {
  const conditions: [string, string, string, string][] = []
  if (filters.username) {
    conditions.push([AccountUpgradeRequest.doctype, "username", "=", filters.username])
  }
  if (filters.status) {
    conditions.push([AccountUpgradeRequest.doctype, "status", "=", filters.status])
  }
  return JSON.stringify(conditions)
}

type QueryFilters = { username?: string; status?: RequestStatus }

class ErpNext {
  url: string
  headers: Record<string, string>

  constructor(url: string, sitename: string, creds: FrappeCredentials) {
    this.url = url
    this.headers = {
      "Content-Type": "application/json",
      "Authorization": `token ${creds.apiKey}:${creds.apiSecret}`,
      "Host": sitename
    }
  }

  async draftCashout(offer: ValidOffer): Promise<LedgerJournal | JournalEntryDraftError> {
    const party = offer.account.erpParty
    if (!party) return new JournalEntryDraftError("Account missing erpParty field")
    const { ibexTrx, flash } = offer.details
    const { liability } = flash
    const flashFee = flash.fee
    const journalEntry = {
      doctype: "Journal Entry",
      company: "Flash",
      multi_currency: 1,
      posting_date: new Date().toISOString().split("T")[0],
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
          party_type: "Customer",
          party,
        },
        {
          account: FrappeConfig.erpnext.accounts.serviceFees,
          account_currency: "USD",
          credit_in_account_currency: erpUsd(flashFee),
          credit: erpUsd(flashFee),
          exchange_rate: 1,
        },
      ],
    }

    try {
      const resp = await axios.post(
        `${this.url}/api/resource/Journal Entry`,
        journalEntry,
        { headers: this.headers },
      )
      const titleResp = this.updateTitle(
        resp.data.data.name,
        `Open cashout ${ibexTrx.invoice.paymentHash.substring(0, 5)}`,
      )
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

  private async updateTitle(
    jeName: string,
    title: string,
  ): Promise<any | JournalEntryTitleError> {
    try {
      const resp = await axios.put(
        `${this.url}/api/resource/Journal Entry/${jeName}`,
        { title },
        { headers: this.headers },
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
        { docstatus: 1 },
        { headers: this.headers },
      )
      return resp.data
    } catch (err) {
      baseLogger.error({ err }, "Error submitting JE in ERPNext")
      return new JournalEntrySubmitError(err)
    }
  }

  async delete(jeName: string): Promise<void | JournalEntryDeleteError> {
    try {
      await axios.delete(`${this.url}/api/resource/Journal Entry/${jeName}`, {
        headers: this.headers,
      })
    } catch (err) {
      baseLogger.error({ err, jeName }, "Error deleting JE in ERPNext")
      return new JournalEntryDeleteError(err)
    }
  }

  async postUpgradeRequest(
    req: Validated<AccountUpgradeRequest>,
  ): Promise<{ name: string } | UpgradeRequestCreateError> {
    try {
      const resp = await axios.post(
        `${this.url}/api/resource/Account Upgrade Request`,
        req.toErpnext(),
        { headers: this.headers },
      )
      return { name: resp.data.data.name }
    } catch (err) {
      baseLogger.error(
        { err, responseData: isAxiosError(err) ? err.response?.data : undefined, ...req.toErpnext() },
        "Error creating Account Upgrade Request in ERPNext",
      )
      return new UpgradeRequestCreateError(err)
    }
  }

  async getAccountUpgradeRequestList(
    filters: QueryFilters,
  ): Promise<string[] | UpgradeRequestQueryError> {
    try {
      const requestParams = buildUpgradeRequestFilters(filters)
      const resp = await axios.get(`${this.url}/api/resource/Account Upgrade Request`, {
        params: { filters: requestParams },
        headers: this.headers,
      })

      return resp.data?.data.map((r: { name: string }) => r.name)
    } catch (err) {
      baseLogger.error(
        { err, filters },
        "Error querying Account Upgrade Request from ERPNext",
      )
      return new UpgradeRequestQueryError(err)
    }
  }

  async getAccountUpgradeRequestById(
    id: string,
  ): Promise<AccountUpgradeRequest | UpgradeRequestQueryError> {
    try {
      const resp = await axios.get(
        `${this.url}/api/resource/Account Upgrade Request/${id}`,
        { headers: this.headers },
      )

      const request = resp.data?.data
      if (!request) return new UpgradeRequestQueryError("No data in detail response")
      return AccountUpgradeRequest.fromErpnext(request)
    } catch (err) {
      baseLogger.error(
        { err, id },
        "Error querying Account Upgrade Request from ERPNext",
      )
      return new UpgradeRequestQueryError(err)
    }
  }

  closeAccountUpgradeRequests = this.setStatusForRequests(RequestStatus.Closed)

  private setStatusForRequests(status: RequestStatus) {
    return async (names: string[]): Promise<void | SetDocTypeValueError> => {
      try {
        const docs = names.map((name) => ({
          doctype: AccountUpgradeRequest.doctype,
          docname: name,
          status,
        }))

        const resp = await axios.post(
          `${this.url}/api/method/frappe.client.bulk_update`,
          { docs: JSON.stringify(docs) },
          { headers: this.headers },
        )

        const failedDocs = resp.data?.message?.failed_docs
        if (failedDocs?.length) {
          baseLogger.error({ failedDocs, names, status }, "Bulk update failed for some docs")
          return new SetDocTypeValueError(failedDocs)
        }
      } catch (err) {
        baseLogger.error({ err, names, status }, "Error bulk updating upgrade request status")
        return new SetDocTypeValueError(err)
      }
    }
  }

  async listBanks(): Promise<Bank[] | BanksQueryError> {
    try {
      const resp = await axios.get(`${this.url}/api/resource/Bank`, {
        headers: this.headers,
      })

      const data = resp.data?.data
      if (!data) return new BanksQueryError("No data in response")

      return data
    } catch (err) {
      baseLogger.error({ err }, "Error querying Banks from ERPNext")
      return new BanksQueryError(err)
    }
  }
}

// Only instantiate if config is available, otherwise export a null-safe placeholder
const erpNextInstance = FrappeConfig?.url
  ? new ErpNext(FrappeConfig.url, FrappeConfig.sitename, FrappeConfig.credentials)
  : null

export default erpNextInstance as ErpNext
