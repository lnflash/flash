import { AccountLevel, AccountStatus } from "@domain/accounts"
import { ValidationError } from "@domain/shared"
import { Address } from "@app/accounts"
import { BankAccount } from "@services/frappe/models/BankAccount"
import {
  AccountUpgradeRequest,
  RequestStatus,
} from "@services/frappe/models/AccountUpgradeRequest"

const mockAddress: Address = {
  title: "Test Address",
  line1: "123 Main St",
  line2: "Apt 4",
  city: "San Salvador",
  state: "SS",
  postalCode: "01101",
  country: "El Salvador",
}

const mockBankAccount: BankAccount = {
  bank: "Test Bank",
  branch_code: "Main Branch",
  account_type: "Savings",
  currency: "USD",
  bank_account_no: "123456789",
}

type RequestOverrides = {
  name?: string
  username?: string
  currentLevel?: AccountLevel
  requestedLevel?: AccountLevel
  status?: string
  fullName?: string
  phoneNumber?: string
  email?: string
  idDocument?: string
  address?: Address
  terminalsRequested?: number
  bankAccount?: BankAccount
}

const makeRequest = (overrides: RequestOverrides = {}) => {
  return new AccountUpgradeRequest(
    overrides.name ?? "ACC-UPGRADE-0001",
    (overrides.username ?? "testuser") as Username,
    overrides.currentLevel ?? AccountLevel.One,
    overrides.requestedLevel ?? AccountLevel.Two,
    overrides.status ?? RequestStatus.Pending,
    overrides.fullName ?? "Test User",
    (overrides.phoneNumber ?? "+15551234567") as PhoneNumber,
    (overrides.email ?? "test@example.com") as EmailAddress,
    overrides.idDocument ?? "ID-DOC-001",
    overrides.address ?? mockAddress,
    overrides.terminalsRequested ?? 1,
    overrides.bankAccount,
  )
}

const makeContext = (overrides: { status?: AccountStatus } = {}) => ({
  account: {
    id: "account-id-001" as AccountId,
    status: overrides.status ?? AccountStatus.Active,
    level: AccountLevel.One,
  } as Account,
  user: {} as User,
  kratos: {} as AnyIdentity,
})

const erpNextResponse = {
  name: "v7mo8aqv0q",
  owner: "erpnext_sa@getflash.io",
  creation: "2026-02-16 10:36:02.194364",
  modified: "2026-02-19 08:46:51.009662",
  modified_by: "Administrator",
  docstatus: 0,
  idx: 0,
  current_level: "ONE",
  requested_level: "TWO",
  status: "Pending",
  username: "john",
  full_name: "Ben Hindman",
  phone_number: "+16505554321",
  id_document: "picture.jpg",
  address_title: "Acme Industries",
  address_line1: "123 Apple St",
  city: "Portmore",
  state: "St. Catherine",
  country: "Jamaica",
  terminal_requested: 1,
  bank_name: "NCB",
  bank_branch: "branch",
  account_type: "chequing",
  account_number: "12345",
  currency: "JMD",
  doctype: "Account Upgrade Request",
}

describe("AccountUpgradeRequest", () => {
  describe("fromErpnext", () => {
    it("should deserialize from ErpNext json", () => {
      const result = AccountUpgradeRequest.fromErpnext(erpNextResponse)

      expect(result.name).toBe("v7mo8aqv0q")
      expect(result.username).toBe("john")
      expect(result.currentLevel).toBe(AccountLevel.One)
      expect(result.requestedLevel).toBe(AccountLevel.Two)
      expect(result.status).toBe("Pending")
      expect(result.fullName).toBe("Ben Hindman")
      expect(result.phoneNumber).toBe("+16505554321")
      expect(result.idDocument).toBe("picture.jpg")
    })

    it("should deserialize address fields", () => {
      const result = AccountUpgradeRequest.fromErpnext(erpNextResponse)

      expect(result.address).toEqual({
        title: "Acme Industries",
        line1: "123 Apple St",
        line2: undefined,
        city: "Portmore",
        state: "St. Catherine",
        postalCode: undefined, // response has no "pincode" field
        country: "Jamaica",
      })
    })

    it("should deserialize bank account fields", () => {
      const result = AccountUpgradeRequest.fromErpnext(erpNextResponse)

      expect(result.bankAccount).toEqual({
        bank: "NCB",
        branch_code: "branch",
        account_type: "chequing",
        currency: "JMD",
        bank_account_no: "12345",
      })
    })

    it("should deserialize terminalsRequested from terminal_requested", () => {
      const result = AccountUpgradeRequest.fromErpnext(erpNextResponse)

      expect(result.terminalsRequested).toBe(1)
    })

    it("should omit bankAccount when bank_name is absent", () => {
      const result = AccountUpgradeRequest.fromErpnext({ ...erpNextResponse, bank_name: undefined })

      expect(result.bankAccount).toBeUndefined()
    })
  })

  describe("toErpnext", () => {
    it("should serialize to ErpNext json", () => {
      const req = makeRequest({ bankAccount: mockBankAccount })
      const result = req.toErpnext()

      expect(result).toMatchObject({
        doctype: "Account Upgrade Request",
        name: "ACC-UPGRADE-0001",
        current_level: "ONE",
        requested_level: "TWO",
        username: "testuser",
        full_name: "Test User",
        phone_number: "+15551234567",
        email: "test@example.com",
        id_document: "ID-DOC-001",
        address_title: "Test Address",
        address_line1: "123 Main St",
        address_line2: "Apt 4",
        city: "San Salvador",
        state: "SS",
        pincode: "01101",
        country: "El Salvador",
        terminal_requested: "1",
        bank_name: "Test Bank",
        bank_branch: "Main Branch",
        account_type: "Savings",
        currency: "USD",
        account_number: "123456789",
      })
    })

    it("should serialize without bank account fields when bankAccount is omitted", () => {
      const req = makeRequest()
      const result = req.toErpnext()

      expect(result.bank_name).toBeUndefined()
      expect(result.bank_branch).toBeUndefined()
      expect(result.account_number).toBeUndefined()
    })
  })

  describe("validate", () => {
    it("should validate account is active", async () => {
      const req = makeRequest()
      const context = makeContext({ status: AccountStatus.Locked })

      const result = await req.validate(context)

      expect(Array.isArray(result)).toBe(true)
      const errors = result as ValidationError[]
      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0]).toBeInstanceOf(ValidationError)
    })

    it("should pass validation when account is active", async () => {
      const req = makeRequest()
      const context = makeContext({ status: AccountStatus.Active })

      const result = await req.validate(context)

      expect(Array.isArray(result)).toBe(false)
    })

    it("should validate account level is greater than current level", async () => {
      const req = makeRequest({
        currentLevel: AccountLevel.Two,
        requestedLevel: AccountLevel.One,
      })
      const context = makeContext()

      const result = await req.validate(context)

      expect(Array.isArray(result)).toBe(true)
      const errors = result as ValidationError[]
      expect(errors.some((e) => e.message.includes("requested level"))).toBe(true)
    })

    it("should fail validation when requested level equals current level", async () => {
      const req = makeRequest({
        currentLevel: AccountLevel.Two,
        requestedLevel: AccountLevel.Two,
      })
      const context = makeContext()

      const result = await req.validate(context)

      expect(Array.isArray(result)).toBe(true)
    })

    it("should validate number of terminals", async () => {
      const req = makeRequest({ terminalsRequested: 2 })
      const context = makeContext()

      const result = await req.validate(context)

      expect(Array.isArray(result)).toBe(true)
      const errors = result as ValidationError[]
      expect(errors.some((e) => e.message.includes("terminal"))).toBe(true)
    })

    it("should pass validation when terminals requested is within limit", async () => {
      const req = makeRequest({ terminalsRequested: 1 })
      const context = makeContext()

      const result = await req.validate(context)

      expect(Array.isArray(result)).toBe(false)
    })
  })
})
