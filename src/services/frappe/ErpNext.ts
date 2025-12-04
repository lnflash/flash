import { CashoutDetails } from "@app/offers"
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
import { FrappeConfig } from "@config"
import ValidOffer from "@app/offers/ValidOffer"

const erpUsd = (usd: USDAmount): number => Number(usd.asCents(2)) // Number(usd.asDollars(2))

/**
 * ERPNext Account Upgrade Request Integration
 *
 * This module integrates with the "Account Upgrade Request" doctype in ERPNext.
 * The doctype must be created in ERPNext with matching field names (snake_case).
 *
 * Account levels in Flash use numeric values (0-3), but ERPNext stores them
 * as string labels ("ZERO", "ONE", "TWO", "THREE") for readability in the UI.
 */
type ErpLevelString = "ZERO" | "ONE" | "TWO" | "THREE"

/** Convert Flash's numeric account level to ERPNext's string representation */
const levelToErpString = (level: number): ErpLevelString => {
  const map: Record<number, ErpLevelString> = { 0: "ZERO", 1: "ONE", 2: "TWO", 3: "THREE" }
  return map[level] || "ZERO"
}

/** Convert ERPNext's string level back to Flash's numeric representation */
const erpStringToLevel = (str: ErpLevelString): number => {
  const map: Record<ErpLevelString, number> = { ZERO: 0, ONE: 1, TWO: 2, THREE: 3 }
  return map[str]
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
    const flashFee = flash.fee // ibexTrx.usd.minus(liability.usd)
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
        { docstatus: 1 }, // docstatus: 1 means submitted
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

  /**
   * Create an Account Upgrade Request document in ERPNext
   *
   * This creates a new record in the "Account Upgrade Request" doctype, which tracks
   * user requests to upgrade their account level (e.g., from Standard to Pro or Merchant).
   *
   * The request is created with status "Pending" and must be approved/rejected manually
   * in ERPNext by an admin (except for Level 2 which auto-upgrades in Flash).
   *
   * Field mapping (camelCase -> snake_case for ERPNext):
   * - User info (from MongoDB): username, phoneNumber, email
   * - User input (from mutation): fullName, businessName, businessAddress, bank details, etc.
   * - System-set: currentLevel, requestedLevel, status
   *
   * @returns The ERPNext document name (ID) on success, or an error
   */
  async createUpgradeRequest(data: {
    currentLevel: number
    requestedLevel: number
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
    // Map camelCase fields to snake_case for ERPNext API
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
      status: "Pending", // All new requests start as Pending
    }

    try {
      const resp = await axios.post(
        `${this.url}/api/resource/Account Upgrade Request`,
        upgradeRequest,
        { headers: this.headers },
      )
      return { name: resp.data.data.name }
    } catch (err) {
      baseLogger.error({ err, upgradeRequest }, "Error creating Account Upgrade Request in ERPNext")
      return new UpgradeRequestCreateError(err)
    }
  }

  /**
   * Query ERPNext for a pending Account Upgrade Request by username
   *
   * Used to check if a user already has a pending upgrade request before
   * allowing them to submit a new one. This prevents duplicate requests.
   *
   * @param username - The Flash username to search for
   * @returns The pending request info, null if none exists, or an error
   */
  async getPendingUpgradeRequest(
    username: string,
  ): Promise<{ name: string; requestedLevel: number } | null | UpgradeRequestQueryError> {
    try {
      // Query ERPNext for pending requests matching this username
      const resp = await axios.get(`${this.url}/api/resource/Account Upgrade Request`, {
        headers: this.headers,
        params: {
          filters: JSON.stringify([
            ["username", "=", username],
            ["status", "=", "Pending"],
          ]),
          fields: JSON.stringify(["name", "requested_level", "status"]),
          limit_page_length: 1, // Only need to know if one exists
        },
      })

      // No pending request found
      if (resp.data.data.length === 0) {
        return null
      }

      // Return the pending request details, converting level back to numeric
      const request = resp.data.data[0]
      return {
        name: request.name,
        requestedLevel: erpStringToLevel(request.requested_level),
      }
    } catch (err) {
      baseLogger.error({ err, username }, "Error querying Account Upgrade Request in ERPNext")
      return new UpgradeRequestQueryError(err)
    }
  }
}

export default new ErpNext(FrappeConfig.url, FrappeConfig.credentials)
