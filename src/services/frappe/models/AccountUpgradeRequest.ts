import { erpStringToLevel, levelToErpString } from "./AccountLevel"

export type CreateUpgradeRequestInput = {
  username: string
  currentLevel: AccountLevel
  requestedLevel: AccountLevel
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

export class AccountUpgradeRequest {
  static doctype = "Account Upgrade Request"

  constructor(
    readonly name: string,
    readonly username: string,
    readonly currentLevel: AccountLevel,
    readonly requestedLevel: AccountLevel,
    readonly status: string,
    readonly fullName: string,
    readonly phoneNumber: string,
    readonly email?: string,
    readonly businessName?: string,
    readonly businessAddress?: string,
    readonly terminalRequested?: boolean,
    readonly bankName?: string,
    readonly bankBranch?: string,
    readonly accountType?: string,
    readonly currency?: string,
    readonly accountNumber?: number,
    readonly idDocument?: string,
  ) {}

  static forCreate(input: CreateUpgradeRequestInput): AccountUpgradeRequest {
    return new AccountUpgradeRequest(
      "", // name - assigned by ERPNext
      input.username,
      input.currentLevel,
      input.requestedLevel,
      "", // status - assigned by ERPNext
      input.fullName,
      input.phoneNumber,
      input.email,
      input.businessName,
      input.businessAddress,
      input.terminalRequested,
      input.bankName,
      input.bankBranch,
      input.accountType,
      input.currency,
      input.accountNumber,
      input.idDocument,
    )
  }

  toErpnext() {
    return {
      doctype: AccountUpgradeRequest.doctype,
      current_level: levelToErpString(this.currentLevel),
      requested_level: levelToErpString(this.requestedLevel),
      username: this.username,
      full_name: this.fullName,
      phone_number: this.phoneNumber,
      email: this.email,
      business_name: this.businessName,
      business_address: this.businessAddress,
      terminal_requested: this.terminalRequested,
      bank_name: this.bankName,
      bank_branch: this.bankBranch,
      account_type: this.accountType,
      currency: this.currency,
      account_number: this.accountNumber,
      id_document: this.idDocument,
    }
  }

  static fromErpnext(data: any): AccountUpgradeRequest {
    return new AccountUpgradeRequest(
      data.name,
      data.username,
      erpStringToLevel(data.current_level),
      erpStringToLevel(data.requested_level),
      data.workflow_state || data.docstatus,
      data.full_name,
      data.phone_number,
      data.email,
      data.business_name,
      data.business_address,
      data.terminal_requested,
      data.bank_name,
      data.bank_branch,
      data.account_type,
      data.currency,
      data.account_number,
      data.id_document,
    )
  }
}
