import { Validated, ValidationError, validator } from "@domain/shared"
import { isActiveAccount } from "@domain/accounts"
import { Address } from "@app/accounts"

import { erpStringToLevel, levelToErpString } from "./AccountLevel"
import { BankAccount } from "./BankAccount"

export enum RequestStatus {
  Pending = "Pending",
  Approved = "Approved",
  Rejected = "Rejected",
  Closed = "Closed",
}

const isRequestedLevelGreater = async (input: AccountUpgradeRequest) => {
  if (input.requestedLevel <= input.currentLevel) {
    return new ValidationError(
      `Account is already at requested level or higher. Current level: ${input.currentLevel}")`,
    )
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

type Context = { account: Account; user: User; kratos: AnyIdentity }

type ErpNextAccountUpgradeRequest = {
  name: string
  username: string
  current_level: string
  requested_level: string
  status: string
  full_name: string
  phone_number: string
  email?: string
  id_document: string
  address_title: string
  address_line1: string
  address_line2?: string
  city: string
  state: string
  pincode?: string
  country: string
  terminal_requested?: number | string
  bank_name?: string
  bank_branch?: string
  account_type?: string
  currency?: string
  account_number?: string
}

// Core model representing an account upgrade request
// with methods to build and representation in different contexts
export class AccountUpgradeRequest {
  static doctype = "Account Upgrade Request"

  readonly name: string
  readonly username: Username
  readonly currentLevel: AccountLevel
  readonly requestedLevel: AccountLevel
  readonly status: string
  readonly fullName: string
  readonly phoneNumber: PhoneNumber
  readonly email: EmailAddress
  readonly idDocument: string
  readonly address: Address
  readonly terminalsRequested: number
  readonly bankAccount?: BankAccount

  constructor(
    name: string,
    username: Username,
    currentLevel: AccountLevel,
    requestedLevel: AccountLevel,
    status: string,
    fullName: string,
    phoneNumber: PhoneNumber,
    email: EmailAddress,
    idDocument: string,
    address: Address,
    terminalsRequested: number,
    bankAccount?: BankAccount,
  ) {
    this.name = name
    this.username = username
    this.currentLevel = currentLevel
    this.requestedLevel = requestedLevel
    this.status = status
    this.fullName = fullName
    this.phoneNumber = phoneNumber
    this.email = email
    this.idDocument = idDocument
    this.address = address
    this.terminalsRequested = terminalsRequested
    this.bankAccount = bankAccount
  }

  async validate(
    context: Context,
  ): Promise<Validated<AccountUpgradeRequest> | ValidationError[]> {
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
      bank_name: this.bankAccount?.bank,
      bank_branch: this.bankAccount?.branch_code,
      account_type: this.bankAccount?.account_type,
      currency: this.bankAccount?.currency,
      account_number: this.bankAccount?.bank_account_no,
      id_document: this.idDocument,
    }
  }

  static fromErpnext(data: ErpNextAccountUpgradeRequest): AccountUpgradeRequest {
    return new AccountUpgradeRequest(
      data.name,
      data.username as Username,
      erpStringToLevel(data.current_level),
      erpStringToLevel(data.requested_level),
      data.status,
      data.full_name,
      data.phone_number as PhoneNumber,
      data.email as EmailAddress,
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
      data.bank_name
        ? {
            bank: data.bank_name,
            branch_code: data.bank_branch || "",
            account_type: data.account_type || "",
            currency: data.currency || "",
            bank_account_no: data.account_number || "",
          }
        : undefined,
    )
  }
}
