// jest.mock calls are hoisted before imports

jest.mock("@app", () => ({
  Accounts: {
    addBankAccount: (...args: unknown[]) => mockAdd(...args),
    updateBankAccount: (...args: unknown[]) => mockUpdate(...args),
    setDefaultBankAccount: (...args: unknown[]) => mockSetDefault(...args),
    deleteBankAccount: (...args: unknown[]) => mockDelete(...args),
  },
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const mockAdd = jest.fn()
const mockUpdate = jest.fn()
const mockSetDefault = jest.fn()
const mockDelete = jest.fn()

import BankAccountAddMutation from "@graphql/public/root/mutation/bank-account-add"
import BankAccountUpdateMutation from "@graphql/public/root/mutation/bank-account-update"
import BankAccountSetDefaultMutation from "@graphql/public/root/mutation/bank-account-set-default"
import BankAccountDeleteMutation from "@graphql/public/root/mutation/bank-account-delete"
import BankAccountUpdateRequestMutation from "@graphql/public/root/mutation/bank-account-update-request"
import {
  BankAccountDuplicateNumberError,
  BankAccountNotOwnedError,
  BankAccountUpgradeRequiredError,
} from "@services/frappe/errors"

type Resolvable = {
  resolve: (
    source: unknown,
    args: { input: Record<string, unknown> },
    context: unknown,
    info: never,
  ) => Promise<Record<string, unknown>>
}

const context = { domainAccount: { id: "acct-1" } }
const resolve = (mutation: unknown, input: Record<string, unknown>) =>
  (mutation as Resolvable).resolve(null, { input }, context, {} as never)

const bankAccount = {
  name: "BANK-ACC-1",
  bank: "NCB",
  branch_code: "Half Way Tree",
  account_type: "Savings",
  currency: "JMD",
  bank_account_no: "123456",
  is_default: 1,
}

describe("self-serve bank account mutations", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("bankAccountAdd", () => {
    const input = {
      bankName: "NCB",
      bankBranch: "Half Way Tree",
      accountType: "Savings",
      currency: "JMD",
      accountNumber: "123456",
      accountName: "Jane Doe",
      setDefault: true,
    }

    it("passes the authenticated account id and the input to the app layer", async () => {
      mockAdd.mockResolvedValue(bankAccount)

      const result = await resolve(BankAccountAddMutation, input)

      expect(mockAdd).toHaveBeenCalledWith("acct-1", input)
      expect(result).toEqual({ errors: [], bankAccount })
    })

    it("returns mapped errors and no account", async () => {
      mockAdd.mockResolvedValue(new BankAccountDuplicateNumberError("dup"))

      const result = await resolve(BankAccountAddMutation, input)

      expect(result.bankAccount).toBeUndefined()
      expect(result.errors).toEqual([
        expect.objectContaining({ code: "BANK_ACCOUNT_DUPLICATE_NUMBER" }),
      ])
    })
  })

  describe("bankAccountUpdate", () => {
    const input = {
      bankAccountId: "BANK-ACC-1",
      bankName: "NCB",
      bankBranch: "Half Way Tree",
      accountType: "Savings",
      accountNumber: "123456",
    }

    it("has no currency input — currency is locked", () => {
      const inputType = (
        BankAccountUpdateMutation as unknown as {
          args: { input: { type: { ofType: { getFields: () => object } } } }
        }
      ).args.input.type.ofType

      expect(Object.keys(inputType.getFields()).sort()).toEqual([
        "accountName",
        "accountNumber",
        "accountType",
        "bankAccountId",
        "bankBranch",
        "bankName",
      ])
    })

    it("returns the updated account", async () => {
      mockUpdate.mockResolvedValue(bankAccount)

      const result = await resolve(BankAccountUpdateMutation, input)

      expect(mockUpdate).toHaveBeenCalledWith("acct-1", input)
      expect(result).toEqual({ errors: [], bankAccount })
    })

    it("returns mapped errors", async () => {
      mockUpdate.mockResolvedValue(new BankAccountNotOwnedError("nope"))

      const result = await resolve(BankAccountUpdateMutation, input)

      expect(result.errors).toEqual([
        expect.objectContaining({ code: "BANK_ACCOUNT_NOT_FOUND" }),
      ])
    })
  })

  describe("bankAccountSetDefault", () => {
    it("returns the new default account", async () => {
      mockSetDefault.mockResolvedValue(bankAccount)

      const result = await resolve(BankAccountSetDefaultMutation, {
        bankAccountId: "BANK-ACC-1",
      })

      expect(mockSetDefault).toHaveBeenCalledWith("acct-1", {
        bankAccountId: "BANK-ACC-1",
      })
      expect(result).toEqual({ errors: [], bankAccount })
    })

    it("returns mapped errors", async () => {
      mockSetDefault.mockResolvedValue(new BankAccountUpgradeRequiredError())

      const result = await resolve(BankAccountSetDefaultMutation, {
        bankAccountId: "BANK-ACC-1",
      })

      expect(result.errors).toEqual([
        expect.objectContaining({ code: "BANK_ACCOUNT_UPGRADE_REQUIRED" }),
      ])
    })
  })

  describe("bankAccountDelete", () => {
    it("returns success", async () => {
      mockDelete.mockResolvedValue(true)

      const result = await resolve(BankAccountDeleteMutation, {
        bankAccountId: "BANK-ACC-1",
      })

      expect(mockDelete).toHaveBeenCalledWith("acct-1", { bankAccountId: "BANK-ACC-1" })
      expect(result).toEqual({ errors: [], success: true })
    })

    it("returns success:false with mapped errors", async () => {
      mockDelete.mockResolvedValue(new BankAccountNotOwnedError("nope"))

      const result = await resolve(BankAccountDeleteMutation, {
        bankAccountId: "BANK-ACC-1",
      })

      expect(result.success).toBe(false)
      expect(result.errors).toEqual([
        expect.objectContaining({ code: "BANK_ACCOUNT_NOT_FOUND" }),
      ])
    })
  })

  it("deprecates bankAccountUpdateRequest in favour of bankAccountUpdate", () => {
    const { deprecationReason } = BankAccountUpdateRequestMutation as unknown as {
      deprecationReason?: string
    }

    expect(deprecationReason).toContain("bankAccountUpdate")
  })
})
