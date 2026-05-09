import ValidOffer from "@app/offers/ValidOffer"
import { FrappeConfig } from "@config"
import { JMDAmount, USDAmount, Validated } from "@domain/shared"
import { baseLogger } from "@services/logger"
import { recordExceptionInCurrentSpan } from "@services/tracing"
import axios, { isAxiosError } from "axios"

import {
  JournalEntryDraftError,
  CashoutSubmitError,
  JournalEntryTitleError,
  JournalEntryDeleteError,
  UpgradeRequestCreateError,
  UpgradeRequestQueryError,
  BanksQueryError,
  BankAccountQueryError,
  SetDocTypeValueError,
} from "./errors"
import {
  AccountUpgradeRequest,
  RequestStatus,
} from "./models/AccountUpgradeRequest"
import { Bank } from "./models/Bank"
import { BankAccount } from "./models/BankAccount"
import { Filter } from "./SearchFilters"

export type AccountUpgradeRequestFilters = { username?: Filter, status?: Filter }
type ErpNextFilter = [string, string, string, string[]]
export const toJson = (filters: AccountUpgradeRequestFilters): string => {
  const erpNextFilters = Object.entries(filters)
    .filter((entry): entry is [string, Filter] => entry[1] !== undefined)
    .map(([key, filter]) => [AccountUpgradeRequest.doctype, key, filter.operator, filter.value] as ErpNextFilter)
  return JSON.stringify(erpNextFilters)
}

// Move to MoneyAmount
const erpUsd = (usd: USDAmount): number => Number(usd.asCents(2))

export type CashoutId = string & { readonly brand: unique symbol }

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

  async draftCashout(offer: ValidOffer): Promise<CashoutId | JournalEntryDraftError> {
    const party = offer.account.erpParty
    if (!party) return new JournalEntryDraftError("Account missing erpParty field")
    const { payment, payout } = offer.details

    try {
      const response = await axios.post(
        `${this.url}/api/resource/Cashout`,
        {
          customer: party,
          bank_account: payout.bankAccountId,
          transaction_id: payment.invoice.paymentHash,
          wallet_id: payment.userAcct,
          flash_wallet: payment.flashAcct,
          user_receives: Number(payout.amount.asDollars()),
          user_pays: Number(payment.amount.asDollars()),
          currency: payout.amount.currencyCode,
          exchange_rate: Number(payout.exchangeRate?.asDollars()),
          flash_fee: Number(payout.serviceFee.asDollars()),
        },           
        { headers: this.headers },
      );
      console.log("Cashout response:", response.data);
      return response.data.data.name as CashoutId
    } catch (err) {
      baseLogger.error({ err }, "Error drafting Cashout in ERPNext")
      return new JournalEntryDraftError(err)
    }
  }

  async submitCashout(cashoutId: CashoutId): Promise<true | CashoutSubmitError> {
    try {
      await axios.post(
        `${this.url}/api/method/admin_panel.admin_panel.doctype.cashout.cashout.submit_cashout`,
        { name: cashoutId },
        { headers: this.headers },
      )
      return true
    } catch (err) {
      const responseData = isAxiosError(err) ? err.response?.data : undefined
      baseLogger.error({ err, responseData }, "Error submitting Cashout in ERPNext")
      return new CashoutSubmitError(err)
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
      const responseData = isAxiosError(err) ? err.response?.data : undefined
      baseLogger.error(
        { err, responseData, ...req.toErpnext() },
        "Error creating Account Upgrade Request in ERPNext",
      )
      recordExceptionInCurrentSpan({ error: err, attributes: { "erpnext.exception": responseData?.exception } })
      return new UpgradeRequestCreateError(err)
    }
  }

  async getAccountUpgradeRequestList(
    filters: AccountUpgradeRequestFilters,
  ): Promise<string[] | UpgradeRequestQueryError> {
    try {
      const resp = await axios.get(`${this.url}/api/resource/${AccountUpgradeRequest.doctype}`, {
        params: { 
          filters: toJson(filters),
          order_by: "creation desc",
        },
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

  async getBankAccountsByCustomer(
    customerName: string,
  ): Promise<BankAccount[] | BankAccountQueryError> {
    try {
      const filters = `[["party_type","=","Customer"],["party","=","${customerName}"]]`
      const fields = `["name","account_name","bank","bank_account_no","branch_code","account_type","currency","is_default"]`
      const resp = await axios.get(
        `${this.url}/api/resource/Bank%20Account?filters=${filters}&fields=${fields}`,
        { headers: this.headers },
      )
      return resp.data?.data ?? []
    } catch (err) {
      baseLogger.error({ err, customerName }, "Error querying Bank Account from ERPNext")
      return new BankAccountQueryError(err)
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
