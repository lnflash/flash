import { BankAccount } from "./BankAccount"

export type ErpNextBankAccountUpdateRequestData = {
  name: string
  party?: string
  bank_account: string
  status: string
  bank_name: string
  bank_branch: string
  account_type: string
  currency: string
  account_number: string
  support_note?: string
  creation?: string
  modified?: string
}

// Core model representing a request to change the details of an already-approved
// ERPNext Bank Account. The request is reviewed by an admin; on approval the
// existing Bank Account DocType is patched in place, preserving its `name` (the
// identifier cashout offers and the Cashout DocType reference).
export class BankAccountUpdateRequest {
  static doctype = "Bank Account Update Request"

  readonly name: string
  readonly party: string
  readonly bankAccountId: string
  readonly status: string
  readonly newBankAccount: BankAccount
  readonly supportNote?: string

  constructor(
    name: string,
    party: string,
    bankAccountId: string,
    status: string,
    newBankAccount: BankAccount,
    supportNote?: string,
  ) {
    this.name = name
    this.party = party
    this.bankAccountId = bankAccountId
    this.status = status
    this.newBankAccount = newBankAccount
    this.supportNote = supportNote
  }

  toErpnext() {
    return {
      doctype: BankAccountUpdateRequest.doctype,
      name: this.name,
      party: this.party,
      bank_account: this.bankAccountId,
      status: this.status,
      bank_name: this.newBankAccount.bank,
      bank_branch: this.newBankAccount.branch_code,
      account_type: this.newBankAccount.account_type,
      currency: this.newBankAccount.currency,
      account_number: this.newBankAccount.bank_account_no,
      support_note: this.supportNote,
    }
  }

  static fromErpnext(
    data: ErpNextBankAccountUpdateRequestData,
  ): BankAccountUpdateRequest {
    return new BankAccountUpdateRequest(
      data.name,
      data.party ?? "",
      data.bank_account,
      data.status,
      {
        bank: data.bank_name,
        branch_code: data.bank_branch,
        account_type: data.account_type,
        currency: data.currency,
        bank_account_no: data.account_number,
      },
      data.support_note,
    )
  }
}
