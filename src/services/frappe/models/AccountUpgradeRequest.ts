import { erpStringToLevel, levelToErpString } from "./AccountLevel"
import { Validated, ValidationError, validator } from "@domain/shared"
import { isActiveAccount } from "@domain/accounts"
import { Address, BankAccount } from "@app/accounts"

export enum RequestStatus {
  Pending = "Pending",
  Approved = "Approved",
  Rejected = "Rejected",
  Closed = "Closed",
}

const isRequestedLevelGreater = async (input: AccountUpgradeRequest) => {
  if (input.requestedLevel <= input.currentLevel) {
    return new ValidationError(`Account is already at requested level or higher. Current level: ${input.currentLevel}")`)
  }
  return true
}

const checkMaxTerminals = async (input: AccountUpgradeRequest) => {
  const maxTerminals = 1 // get from config
  if (input.terminalsRequested > maxTerminals) {
    return new ValidationError(`Cannot request more than ${maxTerminals} terminal(s)`)
  }
  return true
}

const hasUsername = async (input: AccountUpgradeRequest) => {
  if (!input.username) {
    return new ValidationError("Username is required for upgrade request")
  }
  return true
}

const AccountUpgradeRequestValidator = validator<AccountUpgradeRequest & Context>([
  isActiveAccount,
  isRequestedLevelGreater,
  checkMaxTerminals,
  hasUsername,
])

type Context = { account: Account, user: User, kratos: AnyIdentity }

// Core model representing an account upgrade request 
// with methods to build and representation in different contexts
export class AccountUpgradeRequest {
  static doctype = "Account Upgrade Request"

  constructor(
    readonly name: string,
    readonly username: Username,
    readonly currentLevel: AccountLevel,
    readonly requestedLevel: AccountLevel,
    readonly status: string, 
    readonly fullName: string,
    readonly phoneNumber: PhoneNumber,
    readonly email: EmailAddress,
    readonly idDocument: string,
    readonly address: Address,
    readonly terminalsRequested: number,
    readonly bankAccount?: BankAccount,
  ) {}

  async validate(context: Context): Promise<Validated<AccountUpgradeRequest> | ValidationError[]> {
    const result = await AccountUpgradeRequestValidator({ ...this, ...context })
    if (Array.isArray(result)) return result
    return this as unknown as Validated<AccountUpgradeRequest>
  }

  toErpnext() {
    return {
      doctype: AccountUpgradeRequest.doctype,
      name: this.name,
      current_level: levelToErpString(this.currentLevel),
      requested_level: levelToErpString(this.requestedLevel),
      username: this.username,
      full_name: this.fullName,
      phone_number: this.phoneNumber,
      email: this.email,
      address_title: this.address.title,
      address_line1: this.address.line1,
      address_line2: this.address.line2,
      city: this.address.city,
      state: this.address.state,
      pincode: this.address.postalCode,
      country: this.address.country,
      terminal_requested: this.terminalsRequested.toString(),
      bank_name: this.bankAccount?.bankName,
      bank_branch: this.bankAccount?.bankBranch,
      account_type: this.bankAccount?.accountType,
      currency: this.bankAccount?.currency,
      account_number: this.bankAccount?.accountNumber,
      id_document: this.idDocument,
    }
  }

  static fromErpnext(data: any): AccountUpgradeRequest {
    return new AccountUpgradeRequest(
      data.name,
      data.username,
      erpStringToLevel(data.current_level),
      erpStringToLevel(data.requested_level),
      data.status,
      data.full_name,
      data.phone_number,
      data.email,
      data.id_document,
      {
        title: data.address_title,
        line1: data.address_line1,
        line2: data.address_line2,
        city: data.city,
        state: data.state,
        postalCode: data.pincode,
        country: data.country,
      },
      Number(data.terminal_requested) || 0,
      data.bank_name ? {
        bankName: data.bank_name,
        bankBranch: data.bank_branch,
        accountType: data.account_type,
        currency: data.currency,
        accountNumber: data.account_number,
      } : undefined
    )
  }
}
