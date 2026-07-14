import ValidOffer from "@app/offers/ValidOffer"
import { FrappeConfig } from "@config"
import { JMDAmount, USDTAmount, Validated } from "@domain/shared"
import { baseLogger } from "@services/logger"
import { recordExceptionInCurrentSpan } from "@services/tracing"
import axios, { isAxiosError } from "axios"

import {
  BankAccountQueryError,
  BankAccountUpdateRequestCreateError,
  BankAccountUpdateRequestQueryError,
  BanksQueryError,
  BridgeTransferRequestUpsertError,
  CashoutDraftError,
  CashoutSubmitError,
  ExchangeRateQueryError,
  JournalEntryDeleteError,
  SetDocTypeValueError,
  UpgradeRequestCreateError,
  UpgradeRequestQueryError,
} from "./errors"
import { AccountUpgradeRequest, RequestStatus } from "./models/AccountUpgradeRequest"
import { Bank } from "./models/Bank"
import { BankAccount } from "./models/BankAccount"
import {
  BankAccountUpdateRequest,
  ErpNextBankAccountUpdateRequestData,
} from "./models/BankAccountUpdateRequest"
import { BridgeTransferRequest } from "./models/BridgeTransferRequest"
import { Filter } from "./SearchFilters"

export type AccountUpgradeRequestFilters = { username?: Filter; status?: Filter }
type ErpNextFilter = [string, string, string, string[]]
export const toJson = (filters: AccountUpgradeRequestFilters): string => {
  const erpNextFilters = Object.entries(filters)
    .filter((entry): entry is [string, Filter] => entry[1] !== undefined)
    .map(
      ([key, filter]) =>
        [
          AccountUpgradeRequest.doctype,
          key,
          filter.operator,
          filter.value,
        ] as ErpNextFilter,
    )
  return JSON.stringify(erpNextFilters)
}

export type CashoutId = string & { readonly brand: unique symbol }

export class ErpNext {
  url: string
  headers: Record<string, string>

  constructor(url: string, sitename: string, creds: FrappeCredentials) {
    this.url = url
    this.headers = {
      "Content-Type": "application/json",
      "Authorization": `token ${creds.apiKey}:${creds.apiSecret}`,
      "Host": sitename,
      "Expect": "",
    }
  }

  async draftCashout(offer: ValidOffer): Promise<CashoutId | CashoutDraftError> {
    const party = offer.account.erpParty
    if (!party) return new CashoutDraftError("Account missing erpParty field")
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
          // 1 USDT = 1 USD; USDTAmount exposes major units via asNumber (no asDollars).
          user_pays: Number(
            payment.amount instanceof USDTAmount
              ? payment.amount.asNumber(2)
              : payment.amount.asDollars(),
          ),
          currency: payout.amount.currencyCode,
          exchange_rate: payout.exchangeRate
            ? Number(payout.exchangeRate.asDollars())
            : undefined,
          flash_fee: Number(payout.serviceFee.asDollars()),
        },
        { headers: this.headers },
      )
      return response.data.data.name as CashoutId
    } catch (err) {
      const responseData = isAxiosError(err) ? err.response?.data : undefined
      baseLogger.error({ err, responseData }, "Error drafting Cashout in ERPNext")
      recordExceptionInCurrentSpan({
        error: err,
        attributes: { "erpnext.exception": responseData?.exception },
      })
      return new CashoutDraftError(err)
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
      recordExceptionInCurrentSpan({
        error: err,
        attributes: { "erpnext.exception": responseData?.exception },
      })
      return new CashoutSubmitError(err)
    }
  }

  async delete(jeName: string): Promise<void | JournalEntryDeleteError> {
    try {
      await axios.delete(`${this.url}/api/resource/Journal Entry/${jeName}`, {
        headers: this.headers,
      })
    } catch (err) {
      const responseData = isAxiosError(err) ? err.response?.data : undefined
      baseLogger.error({ err, responseData, jeName }, "Error deleting JE in ERPNext")
      recordExceptionInCurrentSpan({
        error: err,
        attributes: { "erpnext.exception": responseData?.exception },
      })
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
      recordExceptionInCurrentSpan({
        error: err,
        attributes: { "erpnext.exception": responseData?.exception },
      })
      return new UpgradeRequestCreateError(err)
    }
  }

  async getAccountUpgradeRequestList(
    filters: AccountUpgradeRequestFilters,
  ): Promise<string[] | UpgradeRequestQueryError> {
    try {
      const resp = await axios.get(
        `${this.url}/api/resource/${AccountUpgradeRequest.doctype}`,
        {
          params: {
            filters: toJson(filters),
            order_by: "creation desc",
          },
          headers: this.headers,
        },
      )

      return resp.data?.data.map((r: { name: string }) => r.name)
    } catch (err) {
      const responseData = isAxiosError(err) ? err.response?.data : undefined
      baseLogger.error(
        { err, responseData, filters },
        "Error querying Account Upgrade Request from ERPNext",
      )
      recordExceptionInCurrentSpan({
        error: err,
        attributes: { "erpnext.exception": responseData?.exception },
      })
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
      const responseData = isAxiosError(err) ? err.response?.data : undefined
      baseLogger.error(
        { err, responseData, id },
        "Error querying Account Upgrade Request from ERPNext",
      )
      recordExceptionInCurrentSpan({
        error: err,
        attributes: { "erpnext.exception": responseData?.exception },
      })
      return new UpgradeRequestQueryError(err)
    }
  }

  closeAccountUpgradeRequests = this.setStatusForRequests(
    AccountUpgradeRequest.doctype,
    RequestStatus.Closed,
  )

  closeBankAccountUpdateRequests = this.setStatusForRequests(
    BankAccountUpdateRequest.doctype,
    RequestStatus.Closed,
  )

  private setStatusForRequests(doctype: string, status: RequestStatus) {
    return async (names: string[]): Promise<void | SetDocTypeValueError> => {
      if (names.length === 0) return
      try {
        const docs = names.map((name) => ({
          doctype,
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
          baseLogger.error(
            { failedDocs, names, status },
            "Bulk update failed for some docs",
          )
          return new SetDocTypeValueError(failedDocs)
        }
      } catch (err) {
        const responseData = isAxiosError(err) ? err.response?.data : undefined
        baseLogger.error(
          { err, responseData, names, status },
          "Error bulk updating upgrade request status",
        )
        recordExceptionInCurrentSpan({
          error: err,
          attributes: { "erpnext.exception": responseData?.exception },
        })
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
      const responseData = isAxiosError(err) ? err.response?.data : undefined
      baseLogger.error(
        { err, responseData, customerName },
        "Error querying Bank Account from ERPNext",
      )
      recordExceptionInCurrentSpan({
        error: err,
        attributes: { "erpnext.exception": responseData?.exception },
      })
      return new BankAccountQueryError(err)
    }
  }

  async getCashoutExchangeRate(): Promise<JMDAmount | ExchangeRateQueryError> {
    try {
      // Cashout is money-out, so it settles at the bank's *buy* side (for_buying).
      // The weekly NCB scrape upserts Currency Exchange records; the newest one is
      // the live rate (ERPNext serves the most recent rate <= posting date).
      const filters = `[["from_currency","=","USD"],["to_currency","=","JMD"],["for_buying","=",1]]`
      const fields = `["exchange_rate","date"]`
      const resp = await axios.get(
        `${this.url}/api/resource/Currency%20Exchange?filters=${filters}&fields=${fields}&order_by=date%20desc&limit_page_length=1`,
        { headers: this.headers },
      )

      const rate = resp.data?.data?.[0]?.exchange_rate
      if (typeof rate !== "number" || !(rate > 0)) {
        return new ExchangeRateQueryError("No USD->JMD for_buying rate found in ERPNext")
      }

      const jmdRate = JMDAmount.dollars(rate)
      if (jmdRate instanceof Error) return new ExchangeRateQueryError(jmdRate)
      return jmdRate
    } catch (err) {
      const responseData = isAxiosError(err) ? err.response?.data : undefined
      baseLogger.error(
        { err, responseData },
        "Error querying Currency Exchange from ERPNext",
      )
      recordExceptionInCurrentSpan({
        error: err,
        attributes: { "erpnext.exception": responseData?.exception },
      })
      return new ExchangeRateQueryError(err)
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
      const responseData = isAxiosError(err) ? err.response?.data : undefined
      baseLogger.error({ err, responseData }, "Error querying Banks from ERPNext")
      recordExceptionInCurrentSpan({
        error: err,
        attributes: { "erpnext.exception": responseData?.exception },
      })
      return new BanksQueryError(err)
    }
  }

  async postBankAccountUpdateRequest(
    req: BankAccountUpdateRequest,
  ): Promise<{ name: string } | BankAccountUpdateRequestCreateError> {
    try {
      const resp = await axios.post(
        `${this.url}/api/resource/${encodeURIComponent(BankAccountUpdateRequest.doctype)}`,
        req.toErpnext(),
        { headers: this.headers },
      )
      return { name: resp.data.data.name }
    } catch (err) {
      const responseData = isAxiosError(err) ? err.response?.data : undefined
      baseLogger.error(
        { err, responseData, ...req.toErpnext() },
        "Error creating Bank Account Update Request in ERPNext",
      )
      recordExceptionInCurrentSpan({
        error: err,
        attributes: { "erpnext.exception": responseData?.exception },
      })
      return new BankAccountUpdateRequestCreateError(err)
    }
  }

  async getOpenBankAccountUpdateRequestsForAccount(
    bankAccountId: string,
  ): Promise<BankAccountUpdateRequest[] | BankAccountUpdateRequestQueryError> {
    try {
      const filters = JSON.stringify([
        ["bank_account", "=", bankAccountId],
        ["status", "=", RequestStatus.Pending],
      ])
      const fields = JSON.stringify([
        "name",
        "party",
        "bank_account",
        "status",
        "bank_name",
        "bank_branch",
        "account_type",
        "currency",
        "account_number",
        "support_note",
      ])
      const resp = await axios.get(
        `${this.url}/api/resource/${encodeURIComponent(BankAccountUpdateRequest.doctype)}`,
        {
          params: { filters, fields, order_by: "creation desc" },
          headers: this.headers,
        },
      )
      const rows: ErpNextBankAccountUpdateRequestData[] = resp.data?.data ?? []
      return rows.map((r) => BankAccountUpdateRequest.fromErpnext(r))
    } catch (err) {
      const responseData = isAxiosError(err) ? err.response?.data : undefined
      baseLogger.error(
        { err, responseData, bankAccountId },
        "Error querying Bank Account Update Request from ERPNext",
      )
      recordExceptionInCurrentSpan({
        error: err,
        attributes: { "erpnext.exception": responseData?.exception },
      })
      return new BankAccountUpdateRequestQueryError(err)
    }
  }

  // Most-recent request for an account (any status), so the API can surface
  // both "Pending" (under review) and "Rejected" (needs the user's attention),
  // and fall silent once the latest request is Approved or Closed.
  async getLatestBankAccountUpdateRequestForAccount(
    bankAccountId: string,
  ): Promise<BankAccountUpdateRequest | undefined | BankAccountUpdateRequestQueryError> {
    try {
      const filters = JSON.stringify([["bank_account", "=", bankAccountId]])
      const fields = JSON.stringify([
        "name",
        "party",
        "bank_account",
        "status",
        "bank_name",
        "bank_branch",
        "account_type",
        "currency",
        "account_number",
        "support_note",
      ])
      const resp = await axios.get(
        `${this.url}/api/resource/${encodeURIComponent(BankAccountUpdateRequest.doctype)}`,
        {
          params: { filters, fields, order_by: "creation desc", limit_page_length: 1 },
          headers: this.headers,
        },
      )
      const rows: ErpNextBankAccountUpdateRequestData[] = resp.data?.data ?? []
      return rows.length ? BankAccountUpdateRequest.fromErpnext(rows[0]) : undefined
    } catch (err) {
      const responseData = isAxiosError(err) ? err.response?.data : undefined
      baseLogger.error(
        { err, responseData, bankAccountId },
        "Error querying latest Bank Account Update Request from ERPNext",
      )
      recordExceptionInCurrentSpan({
        error: err,
        attributes: { "erpnext.exception": responseData?.exception },
      })
      return new BankAccountUpdateRequestQueryError(err)
    }
  }

  async upsertBridgeTransferRequest(
    request: BridgeTransferRequest,
  ): Promise<true | BridgeTransferRequestUpsertError> {
    const payload = request.toErpnext()
    const requestId = payload.request_id

    try {
      const existingName = await this.findBridgeTransferRequestName(requestId)
      if (existingName instanceof BridgeTransferRequestUpsertError) return existingName

      if (existingName) {
        await axios.put(
          `${this.url}/api/resource/${encodeURIComponent(BridgeTransferRequest.doctype)}/${encodeURIComponent(existingName)}`,
          payload,
          { headers: this.headers },
        )
        return true
      }

      try {
        await axios.post(
          `${this.url}/api/resource/${BridgeTransferRequest.doctype}`,
          payload,
          { headers: this.headers },
        )
        return true
      } catch (err) {
        if (!this.isDuplicateRequestError(err)) throw err

        const racedName = await this.findBridgeTransferRequestName(requestId)
        if (racedName instanceof BridgeTransferRequestUpsertError) return racedName
        if (!racedName) throw err

        await axios.put(
          `${this.url}/api/resource/${encodeURIComponent(BridgeTransferRequest.doctype)}/${encodeURIComponent(racedName)}`,
          payload,
          { headers: this.headers },
        )
        return true
      }
    } catch (err) {
      const responseData = isAxiosError(err) ? err.response?.data : undefined
      baseLogger.error(
        { err, responseData, requestId },
        "Error upserting Bridge Transfer Request in ERPNext",
      )
      recordExceptionInCurrentSpan({
        error: err,
        attributes: { "erpnext.exception": responseData?.exception },
      })
      return new BridgeTransferRequestUpsertError(err)
    }
  }

  private async findBridgeTransferRequestName(
    requestId: string,
  ): Promise<string | undefined | BridgeTransferRequestUpsertError> {
    try {
      const filters = JSON.stringify([
        [BridgeTransferRequest.doctype, "request_id", "=", requestId],
      ])
      const fields = JSON.stringify(["name"])
      const resp = await axios.get(
        `${this.url}/api/resource/${encodeURIComponent(BridgeTransferRequest.doctype)}`,
        {
          params: { filters, fields, limit_page_length: 1 },
          headers: this.headers,
        },
      )

      return resp.data?.data?.[0]?.name
    } catch (err) {
      const responseData = isAxiosError(err) ? err.response?.data : undefined
      baseLogger.error(
        { err, responseData, requestId },
        "Error querying Bridge Transfer Request from ERPNext",
      )
      recordExceptionInCurrentSpan({
        error: err,
        attributes: { "erpnext.exception": responseData?.exception },
      })
      return new BridgeTransferRequestUpsertError(err)
    }
  }

  private isDuplicateRequestError(err: unknown): boolean {
    if (!isAxiosError(err)) return false
    const status = err.response?.status
    const responseData = err.response?.data
    const message = JSON.stringify(responseData ?? err.message).toLowerCase()
    return status === 409 || message.includes("duplicate") || message.includes("unique")
  }
}

// Only instantiate if config is available, otherwise export a null-safe placeholder
const erpNextInstance = FrappeConfig?.url
  ? new ErpNext(FrappeConfig.url, FrappeConfig.sitename, FrappeConfig.credentials)
  : null

export default erpNextInstance as ErpNext
