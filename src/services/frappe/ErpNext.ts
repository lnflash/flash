import { CashoutDetails } from "@app/offers"
import ValidOffer from "@app/offers/ValidOffer"
import { FrappeConfig } from "@config"
import { AccountLevel } from "@domain/accounts"
import { USDAmount } from "@domain/shared"
import { baseLogger } from "@services/logger"

import axios from "axios"

import {
  JournalEntryDraftError,
  JournalEntrySubmitError,
  JournalEntryTitleError,
  JournalEntryDeleteError,
  UpgradeRequestCreateError,
  UpgradeRequestQueryError,
} from "./errors"

const erpUsd = (usd: USDAmount): number => Number(usd.asCents(2))

type ErpLevelString = "ZERO" | "ONE" | "TWO" | "THREE"

const levelToErpString = (level: AccountLevel): ErpLevelString => {
  const map: Record<AccountLevel, ErpLevelString> = {
    [AccountLevel.Zero]: "ZERO",
    [AccountLevel.One]: "ONE",
    [AccountLevel.Two]: "TWO",
    [AccountLevel.Three]: "THREE",
  }
  return map[level] || "ZERO"
}

const erpStringToLevel = (erpLevel: ErpLevelString): AccountLevel => {
  const map: Record<ErpLevelString, AccountLevel> = {
    ZERO: AccountLevel.Zero,
    ONE: AccountLevel.One,
    TWO: AccountLevel.Two,
    THREE: AccountLevel.Three,
  }
  return map[erpLevel] ?? AccountLevel.Zero
}

export type AccountUpgradeRequest = {
  name: string
  username: string
  currentLevel: AccountLevel
  requestedLevel: AccountLevel
  status: string
  fullName: string
  phoneNumber: string
  email?: string
  businessName?: string
  businessAddress?: string
  terminalRequested?: boolean
  bankName?: string
  bankBranch?: string
  accountType?: string
  currency?: string
  accountNumber?: number
  idDocument?: string
}

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
          party_type: "Supplier",
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

  async createUpgradeRequest(data: {
    currentLevel: AccountLevel
    requestedLevel: AccountLevel
    username: string
    fullName: string
    phoneNumber: string
    email?: string
    businessName?: string
    businessAddress?: string
    terminalRequested?: boolean
    bankName?: string
    bankBranch?: string
    accountType?: string
    currency?: string
    accountNumber?: number
    idDocument?: string
  }): Promise<{ name: string } | UpgradeRequestCreateError> {
    const upgradeRequest = {
      doctype: "Account Upgrade Request",
      current_level: levelToErpString(data.currentLevel),
      requested_level: levelToErpString(data.requestedLevel),
      username: data.username,
      full_name: data.fullName,
      phone_number: data.phoneNumber,
      email: data.email,
      business_name: data.businessName,
      business_address: data.businessAddress,
      terminal_requested: data.terminalRequested,
      bank_name: data.bankName,
      bank_branch: data.bankBranch,
      account_type: data.accountType,
      currency: data.currency,
      account_number: data.accountNumber,
      id_document: data.idDocument,
    }

    try {
      const resp = await axios.post(
        `${this.url}/api/resource/Account Upgrade Request`,
        upgradeRequest,
        { headers: this.headers },
      )
      return { name: resp.data.data.name }
    } catch (err) {
      baseLogger.error(
        { err, upgradeRequest },
        "Error creating Account Upgrade Request in ERPNext",
      )
      return new UpgradeRequestCreateError(err)
    }
  }

  async getAccountUpgradeRequest(
    username: string,
  ): Promise<AccountUpgradeRequest | null | UpgradeRequestQueryError> {
    try {
      const filters = JSON.stringify([
        ["Account Upgrade Request", "username", "=", username],
      ])
      const resp = await axios.get(`${this.url}/api/resource/Account Upgrade Request`, {
        params: { filters },
        headers: this.headers,
      })

      const data = resp.data?.data
      if (!data || data.length === 0) {
        return null
      }

      // Get the most recent request
      const latestRequest = data[0]

      // Fetch full details
      const detailResp = await axios.get(
        `${this.url}/api/resource/Account Upgrade Request/${latestRequest.name}`,
        { headers: this.headers },
      )

      const request = detailResp.data?.data
      if (!request) {
        return null
      }

      return {
        name: request.name,
        username: request.username,
        currentLevel: erpStringToLevel(request.current_level),
        requestedLevel: erpStringToLevel(request.requested_level),
        status: request.workflow_state || request.docstatus,
        fullName: request.full_name,
        phoneNumber: request.phone_number,
        email: request.email,
        businessName: request.business_name,
        businessAddress: request.business_address,
        terminalRequested: request.terminal_requested,
        bankName: request.bank_name,
        bankBranch: request.bank_branch,
        accountType: request.account_type,
        currency: request.currency,
        accountNumber: request.account_number,
        idDocument: request.id_document,
      }
    } catch (err) {
      baseLogger.error(
        { err, username },
        "Error querying Account Upgrade Request from ERPNext",
      )
      return new UpgradeRequestQueryError(err)
    }
  }
}

// Only instantiate if config is available, otherwise export a null-safe placeholder
const erpNextInstance = FrappeConfig?.url
  ? new ErpNext(FrappeConfig.url, FrappeConfig.credentials)
  : null

export default erpNextInstance as ErpNext
