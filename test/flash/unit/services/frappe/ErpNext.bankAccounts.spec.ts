jest.mock("axios", () => ({
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  isAxiosError: jest.fn((err) => Boolean(err?.isAxiosError)),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/tracing", () => ({
  recordExceptionInCurrentSpan: jest.fn(),
}))

jest.mock("@config", () => ({
  FrappeConfig: undefined,
}))

import axios from "axios"
import { ErpNext } from "@services/frappe/ErpNext"
import { baseLogger } from "@services/logger"
import { recordExceptionInCurrentSpan } from "@services/tracing"
import {
  BankAccountCreateError,
  BankAccountDeleteError,
  BankAccountDuplicateNumberError,
  BankAccountNotOwnedError,
  BankAccountQueryError,
  BankAccountSetDefaultError,
  BankAccountUpdateError,
  BankAccountUpgradeRequiredError,
  BankAccountValidationError,
  BankAccountValidationReason,
} from "@services/frappe/errors"

const mockedAxios = axios as unknown as {
  get: jest.Mock
  post: jest.Mock
  put: jest.Mock
}
const loggedError = baseLogger.error as jest.Mock
const recordedException = recordExceptionInCurrentSpan as jest.Mock

const client = new ErpNext("https://erp.example", "erp.example", {
  apiKey: "key",
  apiSecret: "secret",
})

const BANKING = "https://erp.example/api/method/admin_panel.api.banking"
const ACCOUNT_NUMBER = "9988776655"

// What frappe.throw() looks like on the wire: a 417 whose `_server_messages` is
// a JSON array of JSON strings. `config.data` is the request body axios keeps on
// the error — it carries the full account number.
const frappeThrow = (text: string, excType = "ValidationError", status = 417) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    config: { data: JSON.stringify({ account_number: ACCOUNT_NUMBER }) },
    response: {
      status,
      data: {
        exc_type: excType,
        exception: `frappe.exceptions.${excType}: ${text}`,
        _server_messages: JSON.stringify([JSON.stringify({ message: text })]),
      },
    },
  })

const serverFailure = () =>
  Object.assign(new Error("Request failed with status code 500"), {
    isAxiosError: true,
    config: { data: JSON.stringify({ account_number: ACCOUNT_NUMBER }) },
    response: {
      status: 500,
      data: { message: { success: false, error: "An internal error occurred" } },
    },
  })

const createArgs = {
  erpParty: "CUST-1",
  bankName: "NCB",
  accountNumber: ACCOUNT_NUMBER,
  accountType: "Savings",
  currency: "JMD",
  bankBranch: "Half Way Tree",
  accountName: "Jane Doe",
  setDefault: true,
}

const updateArgs = {
  bankAccountId: "Jane Doe - NCB",
  erpParty: "CUST-1",
  bankName: "Scotiabank",
  accountNumber: ACCOUNT_NUMBER,
  accountType: "Chequing",
  currency: "JMD",
  bankBranch: "New Kingston",
}

const expectNoFullAccountNumberLogged = () => {
  expect(loggedError).toHaveBeenCalled()
  expect(JSON.stringify(loggedError.mock.calls)).not.toContain(ACCOUNT_NUMBER)
  expect(
    JSON.stringify(
      recordedException.mock.calls.map(([arg]) => ({
        message: arg.error?.message,
        config: arg.error?.config,
        attributes: arg.attributes,
      })),
    ),
  ).not.toContain(ACCOUNT_NUMBER)
}

describe("ErpNext bank accounts", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("getBankAccountsByCustomer", () => {
    it("filters out disabled (soft-deleted) accounts", async () => {
      mockedAxios.get.mockResolvedValue({ data: { data: [{ name: "BANK-ACC-1" }] } })

      const result = await client.getBankAccountsByCustomer("CUST-1")

      expect(result).toEqual([{ name: "BANK-ACC-1" }])
      const url: string = mockedAxios.get.mock.calls[0][0]
      expect(url).toContain("https://erp.example/api/resource/Bank%20Account?filters=")
      expect(url).toContain('["disabled","=",0]')
      expect(url).toContain('["party_type","=","Customer"]')
      expect(url).toContain('["party","=","CUST-1"]')
    })

    it("asks for every account, not Frappe's default first page of 20", async () => {
      mockedAxios.get.mockResolvedValue({ data: { data: [] } })

      await client.getBankAccountsByCustomer("CUST-1")

      const url: string = mockedAxios.get.mock.calls[0][0]
      expect(new URL(url).searchParams.get("limit_page_length")).toBe("0")
    })

    it("returns an empty list when ERPNext has no rows", async () => {
      mockedAxios.get.mockResolvedValue({ data: {} })

      expect(await client.getBankAccountsByCustomer("CUST-1")).toEqual([])
    })

    it("returns a query error when the lookup fails", async () => {
      mockedAxios.get.mockRejectedValue({ isAxiosError: true, response: { data: {} } })

      const result = await client.getBankAccountsByCustomer("CUST-1")

      expect(result).toBeInstanceOf(BankAccountQueryError)
    })
  })

  describe("createBankAccount", () => {
    it("posts to add_bank_account and returns the new id", async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { success: true, bank_account: "Jane Doe - NCB" } },
      })

      const result = await client.createBankAccount(createArgs)

      expect(result).toEqual({ bankAccountId: "Jane Doe - NCB" })
      expect(mockedAxios.post).toHaveBeenCalledTimes(1)
      expect(mockedAxios.post).toHaveBeenCalledWith(
        `${BANKING}.add_bank_account`,
        {
          erp_party: "CUST-1",
          bank_name: "NCB",
          account_number: ACCOUNT_NUMBER,
          account_type: "Savings",
          currency: "JMD",
          bank_branch: "Half Way Tree",
          account_name: "Jane Doe",
          set_default: 1,
        },
        { headers: client.headers },
      )
    })

    it("sends set_default 0 unless asked", async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { success: true, bank_account: "Jane Doe - NCB" } },
      })

      await client.createBankAccount({ ...createArgs, setDefault: undefined })

      expect(mockedAxios.post.mock.calls[0][1].set_default).toBe(0)
    })

    it("returns a create error when the response has no bank_account", async () => {
      mockedAxios.post.mockResolvedValue({ data: { message: { success: true } } })

      const result = await client.createBankAccount(createArgs)

      expect(result).toBeInstanceOf(BankAccountCreateError)
    })

    it("returns a create error for an in-band success:false", async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { success: false, error: "An internal error occurred" } },
      })

      const result = await client.createBankAccount(createArgs)

      expect(result).toBeInstanceOf(BankAccountCreateError)
      expect((result as Error).message).toBe("An internal error occurred")
    })

    it("maps the duplicate-number refusal", async () => {
      mockedAxios.post.mockRejectedValue(
        frappeThrow("A bank account with this account number already exists."),
      )

      const result = await client.createBankAccount(createArgs)

      expect(result).toBeInstanceOf(BankAccountDuplicateNumberError)
    })

    it.each([
      [
        "currency must be JMD or USD — cashout accepts nothing else",
        BankAccountValidationReason.Currency,
      ],
      [
        "account_type must be one of: Chequing, Savings",
        BankAccountValidationReason.AccountType,
      ],
      ["bank_name is required", BankAccountValidationReason.BankName],
      ["account_number is required", BankAccountValidationReason.AccountNumber],
    ])(
      "maps the banking.py refusal %p to a validation error with OUR text",
      async (thrown, expected) => {
        mockedAxios.post.mockRejectedValue(frappeThrow(thrown))

        const result = await client.createBankAccount(createArgs)

        expect(result).toBeInstanceOf(BankAccountValidationError)
        expect((result as Error).message).toBe(expected)
      },
    )

    it("maps the unknown-ERP-customer refusal to upgrade-required", async () => {
      mockedAxios.post.mockRejectedValue(
        frappeThrow("Unknown ERP customer — the account needs an ERP party first."),
      )

      expect(await client.createBankAccount(createArgs)).toBeInstanceOf(
        BankAccountUpgradeRequiredError,
      )
    })

    it.each([
      [
        "a missing endpoint",
        "Failed to get method for command admin_panel.api.banking.add_bank_account with module 'admin_panel.api.banking' has no attribute 'add_bank_account'",
        "ValidationError",
      ],
      [
        "a Frappe length check",
        "Bank Account: <b>Branch Code</b> will get truncated, as max characters allowed is 140",
        "CharacterLengthExceededError",
      ],
      [
        "a Frappe mandatory check",
        "Value missing for Bank Account: Bank",
        "MandatoryError",
      ],
      [
        "a Frappe link check",
        "Could not find Bank: <a href='/app/bank/x'>x</a>",
        "LinkValidationError",
      ],
    ])(
      "treats %s (417) as a generic failure, never a customer-facing validation error",
      async (_label, thrown, excType) => {
        mockedAxios.post.mockRejectedValue(frappeThrow(thrown, excType))

        const result = await client.createBankAccount(createArgs)

        expect(result).toBeInstanceOf(BankAccountCreateError)
        expect(result).not.toBeInstanceOf(BankAccountValidationError)
      },
    )

    it("falls back to the exception line when _server_messages is not valid JSON", async () => {
      const err = frappeThrow("bank_name is required")
      err.response.data._server_messages = "not json"
      mockedAxios.post.mockRejectedValue(err)

      const result = await client.createBankAccount(createArgs)

      expect(result).toBeInstanceOf(BankAccountValidationError)
      expect((result as Error).message).toBe(BankAccountValidationReason.BankName)
    })

    it("returns a generic create error on a server failure", async () => {
      mockedAxios.post.mockRejectedValue(serverFailure())

      const result = await client.createBankAccount(createArgs)

      expect(result).toBeInstanceOf(BankAccountCreateError)
    })

    it("returns a generic create error on a permission refusal", async () => {
      mockedAxios.post.mockRejectedValue(
        frappeThrow("User svc does not have permission", "PermissionError", 403),
      )

      const result = await client.createBankAccount(createArgs)

      expect(result).toBeInstanceOf(BankAccountCreateError)
    })

    it("returns a generic create error on a network failure", async () => {
      mockedAxios.post.mockRejectedValue(new Error("ECONNREFUSED"))

      const result = await client.createBankAccount(createArgs)

      expect(result).toBeInstanceOf(BankAccountCreateError)
      expect((result as Error).message).toBe("ECONNREFUSED")
    })

    it("never logs the full account number", async () => {
      mockedAxios.post.mockRejectedValue(serverFailure())

      const result = await client.createBankAccount(createArgs)

      expect(JSON.stringify((result as Error).message)).not.toContain(ACCOUNT_NUMBER)
      expectNoFullAccountNumberLogged()
      expect(loggedError.mock.calls[0][0]).toEqual(
        expect.objectContaining({ erpParty: "CUST-1", accountNumberLast4: "6655" }),
      )
    })
  })

  describe("updateBankAccount", () => {
    it("posts to update_bank_account", async () => {
      mockedAxios.post.mockResolvedValue({ data: { message: { success: true } } })

      const result = await client.updateBankAccount(updateArgs)

      expect(result).toBe(true)
      expect(mockedAxios.post).toHaveBeenCalledWith(
        `${BANKING}.update_bank_account`,
        {
          bank_account_id: "Jane Doe - NCB",
          erp_party: "CUST-1",
          bank_name: "Scotiabank",
          account_number: ACCOUNT_NUMBER,
          account_type: "Chequing",
          currency: "JMD",
          bank_branch: "New Kingston",
          account_name: undefined,
        },
        { headers: client.headers },
      )
    })

    it("returns an update error for an in-band success:false", async () => {
      mockedAxios.post.mockResolvedValue({ data: { message: { success: false } } })

      expect(await client.updateBankAccount(updateArgs)).toBeInstanceOf(
        BankAccountUpdateError,
      )
    })

    it("maps the duplicate-number refusal", async () => {
      mockedAxios.post.mockRejectedValue(
        frappeThrow("Another bank account already uses this account number."),
      )

      expect(await client.updateBankAccount(updateArgs)).toBeInstanceOf(
        BankAccountDuplicateNumberError,
      )
    })

    it("maps the other duplicate wording (number moved onto an existing account)", async () => {
      mockedAxios.post.mockRejectedValue(
        frappeThrow("Another bank account already uses this account number."),
      )

      expect(await client.updateBankAccount(updateArgs)).toBeInstanceOf(
        BankAccountDuplicateNumberError,
      )
    })

    it("maps the own-removed-number refusal to a validation error with OUR text", async () => {
      mockedAxios.post.mockRejectedValue(
        frappeThrow(
          "This account number belongs to a bank account that was removed. Add it again instead of editing another account.",
        ),
      )

      const result = await client.updateBankAccount(updateArgs)

      expect(result).toBeInstanceOf(BankAccountValidationError)
      expect((result as Error).message).toBe(BankAccountValidationReason.OwnRemovedNumber)
    })

    it("maps the ownership refusal", async () => {
      mockedAxios.post.mockRejectedValue(
        frappeThrow("Bank Account does not belong to this customer."),
      )

      expect(await client.updateBankAccount(updateArgs)).toBeInstanceOf(
        BankAccountNotOwnedError,
      )
    })

    it("maps a missing Bank Account (404) to not-owned", async () => {
      mockedAxios.post.mockRejectedValue(
        frappeThrow("Bank Account X not found", "DoesNotExistError", 404),
      )

      expect(await client.updateBankAccount(updateArgs)).toBeInstanceOf(
        BankAccountNotOwnedError,
      )
    })

    it("returns a generic update error on a server failure, without the number", async () => {
      mockedAxios.post.mockRejectedValue(serverFailure())

      expect(await client.updateBankAccount(updateArgs)).toBeInstanceOf(
        BankAccountUpdateError,
      )
      expectNoFullAccountNumberLogged()
    })
  })

  describe("deleteBankAccount", () => {
    const args = { bankAccountId: "Jane Doe - NCB", erpParty: "CUST-1" }

    it("posts to delete_bank_account and returns a hard delete", async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          message: {
            bank_account_id: "Jane Doe - NCB",
            deleted: true,
            disabled: false,
            new_default: "Jane Doe - Scotiabank",
          },
        },
      })

      const result = await client.deleteBankAccount(args)

      expect(result).toEqual({
        bankAccountId: "Jane Doe - NCB",
        deleted: true,
        disabled: false,
        newDefault: "Jane Doe - Scotiabank",
      })
      expect(mockedAxios.post).toHaveBeenCalledWith(
        `${BANKING}.delete_bank_account`,
        { bank_account_id: "Jane Doe - NCB", erp_party: "CUST-1" },
        { headers: client.headers },
      )
    })

    it("returns a soft delete (disabled) with no new default", async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          message: {
            bank_account_id: "Jane Doe - NCB",
            deleted: false,
            disabled: true,
            new_default: null,
          },
        },
      })

      expect(await client.deleteBankAccount(args)).toEqual({
        bankAccountId: "Jane Doe - NCB",
        deleted: false,
        disabled: true,
        newDefault: null,
      })
    })

    it("returns a delete error when nothing was deleted or disabled", async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { bank_account_id: "x", deleted: false, disabled: false } },
      })

      expect(await client.deleteBankAccount(args)).toBeInstanceOf(BankAccountDeleteError)
    })

    it("returns a delete error for an empty or success:false response", async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: {} })
      expect(await client.deleteBankAccount(args)).toBeInstanceOf(BankAccountDeleteError)

      mockedAxios.post.mockResolvedValueOnce({
        data: { message: { success: false, error: "boom", deleted: true } },
      })
      expect(await client.deleteBankAccount(args)).toBeInstanceOf(BankAccountDeleteError)
    })

    it("maps the ownership refusal", async () => {
      mockedAxios.post.mockRejectedValue(
        frappeThrow("Bank Account does not belong to this customer."),
      )

      expect(await client.deleteBankAccount(args)).toBeInstanceOf(
        BankAccountNotOwnedError,
      )
    })

    it("returns a generic delete error on a server failure", async () => {
      mockedAxios.post.mockRejectedValue(serverFailure())

      expect(await client.deleteBankAccount(args)).toBeInstanceOf(BankAccountDeleteError)
    })
  })

  describe("setDefaultBankAccount", () => {
    const args = { bankAccountId: "Jane Doe - NCB", erpParty: "CUST-1" }

    it("posts to set_default_bank_account", async () => {
      mockedAxios.post.mockResolvedValue({ data: { message: { success: true } } })

      expect(await client.setDefaultBankAccount(args)).toBe(true)
      expect(mockedAxios.post).toHaveBeenCalledWith(
        `${BANKING}.set_default_bank_account`,
        { bank_account_id: "Jane Doe - NCB", erp_party: "CUST-1" },
        { headers: client.headers },
      )
    })

    it("returns a set-default error when success is missing", async () => {
      mockedAxios.post.mockResolvedValue({ data: {} })

      expect(await client.setDefaultBankAccount(args)).toBeInstanceOf(
        BankAccountSetDefaultError,
      )
    })

    it("maps the ownership refusal", async () => {
      mockedAxios.post.mockRejectedValue(
        frappeThrow("Bank Account does not belong to this customer."),
      )

      expect(await client.setDefaultBankAccount(args)).toBeInstanceOf(
        BankAccountNotOwnedError,
      )
    })

    it("returns a generic set-default error on a server failure", async () => {
      mockedAxios.post.mockRejectedValue(serverFailure())

      expect(await client.setDefaultBankAccount(args)).toBeInstanceOf(
        BankAccountSetDefaultError,
      )
    })
  })
})

describe("ErpNext.listBanks", () => {
  beforeEach(() => jest.clearAllMocks())

  it("asks for every bank, not Frappe's default first page of 20", async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [{ name: "NCB" }] } })

    const result = await client.listBanks()

    expect(result).toEqual([{ name: "NCB" }])
    const [url, config] = mockedAxios.get.mock.calls[0]
    expect(url).toBe("https://erp.example/api/resource/Bank")
    expect(config.params).toEqual({ limit_page_length: 0 })
  })
})
