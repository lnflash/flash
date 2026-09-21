jest.mock("@services/mongoose", () => {
  const findById = jest.fn()
  return { AccountsRepository: () => ({ findById }) }
})

jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: {
    getBankAccountsByCustomer: jest.fn(),
    listBanks: jest.fn(),
    createBankAccount: jest.fn(),
    updateBankAccount: jest.fn(),
    deleteBankAccount: jest.fn(),
    setDefaultBankAccount: jest.fn(),
    getOpenBankAccountUpdateRequestsForAccount: jest.fn(),
    closeBankAccountUpdateRequests: jest.fn(),
  },
}))

jest.mock("@services/rate-limit", () => ({
  consumeLimiter: jest.fn(),
}))

jest.mock("@domain/rate-limit", () => ({
  RateLimitConfig: { bankAccountManage: { key: "bank_account_manage" } },
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { AccountsRepository } from "@services/mongoose"
import ErpNext from "@services/frappe/ErpNext"
import { consumeLimiter } from "@services/rate-limit"
import { baseLogger } from "@services/logger"
import {
  MAX_BANK_ACCOUNTS,
  addBankAccount,
  deleteBankAccount,
  setDefaultBankAccount,
  updateBankAccount,
} from "@app/accounts/bank-accounts"
import { ValidationError } from "@domain/shared"
import { CouldNotFindAccountError } from "@domain/errors"
import { BankAccountManageRateLimiterExceededError } from "@domain/rate-limit/errors"
import {
  BankAccountCreateError,
  BankAccountDeleteError,
  BankAccountDuplicateNumberError,
  BankAccountNotOwnedError,
  BankAccountQueryError,
  BankAccountSetDefaultError,
  BankAccountUpdateError,
  BankAccountUpdateRequestQueryError,
  BankAccountUpgradeRequiredError,
  BankAccountValidationError,
  BankAccountValidationReason,
  BanksQueryError,
  SetDocTypeValueError,
} from "@services/frappe/errors"

const { findById } = AccountsRepository() as unknown as { findById: jest.Mock }
const erp = ErpNext as unknown as Record<
  | "getBankAccountsByCustomer"
  | "listBanks"
  | "createBankAccount"
  | "updateBankAccount"
  | "deleteBankAccount"
  | "setDefaultBankAccount"
  | "getOpenBankAccountUpdateRequestsForAccount"
  | "closeBankAccountUpdateRequests",
  jest.Mock
>
const limiter = consumeLimiter as jest.Mock

const ACCOUNT_ID = "acct-1" as AccountId
const ownedAccount = { id: ACCOUNT_ID, erpParty: "CUST-1" } as unknown as Account

const storedBank = {
  name: "BANK-ACC-1",
  bank: "NCB",
  branch_code: "Old Branch",
  account_type: "Savings",
  currency: "USD",
  bank_account_no: "111111",
  is_default: 0 as const,
}

const addInput = {
  bankName: "  NCB ",
  bankBranch: " Half Way Tree ",
  accountType: "Savings",
  currency: "jmd",
  accountNumber: " 123456 ",
  accountName: " Jane Doe ",
  setDefault: true,
}

const updateInput = {
  bankAccountId: "BANK-ACC-1",
  bankName: "Scotiabank",
  bankBranch: "New Kingston",
  accountType: "Chequing",
  accountNumber: "222222",
}

const writes = [
  "createBankAccount",
  "updateBankAccount",
  "deleteBankAccount",
  "setDefaultBankAccount",
] as const

const expectNoWrites = () => {
  for (const write of writes) expect(erp[write]).not.toHaveBeenCalled()
}

// Every entry point, so the shared gates are asserted for all four.
const entryPoints: Array<[string, () => Promise<unknown>]> = [
  ["addBankAccount", () => addBankAccount(ACCOUNT_ID, addInput)],
  ["updateBankAccount", () => updateBankAccount(ACCOUNT_ID, updateInput)],
  [
    "setDefaultBankAccount",
    () => setDefaultBankAccount(ACCOUNT_ID, { bankAccountId: "BANK-ACC-1" }),
  ],
  [
    "deleteBankAccount",
    () => deleteBankAccount(ACCOUNT_ID, { bankAccountId: "BANK-ACC-1" }),
  ],
]

beforeEach(() => {
  jest.resetAllMocks()
  findById.mockResolvedValue(ownedAccount)
  limiter.mockResolvedValue(true)
  erp.listBanks.mockResolvedValue([{ name: "NCB" }, { name: "Scotiabank" }])
  erp.getBankAccountsByCustomer.mockResolvedValue([storedBank])
  erp.getOpenBankAccountUpdateRequestsForAccount.mockResolvedValue([])
  erp.closeBankAccountUpdateRequests.mockResolvedValue(undefined)
})

describe.each(entryPoints)("%s — shared gates", (_name, call) => {
  it("returns the repository error when the account cannot be loaded", async () => {
    findById.mockResolvedValue(new CouldNotFindAccountError())

    expect(await call()).toBeInstanceOf(CouldNotFindAccountError)
    expect(erp.getBankAccountsByCustomer).not.toHaveBeenCalled()
    expectNoWrites()
  })

  it("rejects an account with no erpParty before touching ERPNext", async () => {
    findById.mockResolvedValue({ id: ACCOUNT_ID } as unknown as Account)

    expect(await call()).toBeInstanceOf(BankAccountUpgradeRequiredError)
    expect(limiter).not.toHaveBeenCalled()
    expect(erp.getBankAccountsByCustomer).not.toHaveBeenCalled()
    expect(erp.listBanks).not.toHaveBeenCalled()
    expectNoWrites()
  })

  it("consumes the per-account budget and stops when it is spent", async () => {
    limiter.mockResolvedValue(new BankAccountManageRateLimiterExceededError())

    expect(await call()).toBeInstanceOf(BankAccountManageRateLimiterExceededError)
    expect(limiter).toHaveBeenCalledWith({
      rateLimitConfig: { key: "bank_account_manage" },
      keyToConsume: ACCOUNT_ID,
    })
    expect(erp.getBankAccountsByCustomer).not.toHaveBeenCalled()
    expectNoWrites()
  })
})

describe.each(entryPoints.slice(1))("%s — ownership", (_name, call) => {
  it("rejects a bank account that is not in the customer's own list", async () => {
    erp.getBankAccountsByCustomer.mockResolvedValue([
      { ...storedBank, name: "SOMEONE-ELSES-ACC" },
    ])

    expect(await call()).toBeInstanceOf(BankAccountNotOwnedError)
    expect(erp.getBankAccountsByCustomer).toHaveBeenCalledWith("CUST-1")
    expectNoWrites()
  })

  it("propagates a bank account query failure", async () => {
    erp.getBankAccountsByCustomer.mockResolvedValue(new BankAccountQueryError("boom"))

    expect(await call()).toBeInstanceOf(BankAccountQueryError)
    expectNoWrites()
  })
})

describe("addBankAccount", () => {
  const created = {
    ...storedBank,
    name: "Jane Doe - NCB",
    currency: "JMD",
    is_default: 1 as const,
  }

  it("creates with trimmed values and the account's own erpParty, then re-reads", async () => {
    erp.createBankAccount.mockResolvedValue({ bankAccountId: "Jane Doe - NCB" })
    erp.getBankAccountsByCustomer.mockResolvedValue([storedBank, created])

    const result = await addBankAccount(ACCOUNT_ID, addInput)

    expect(result).toBe(created)
    expect(erp.createBankAccount).toHaveBeenCalledWith({
      erpParty: "CUST-1",
      bankName: "NCB",
      bankBranch: "Half Way Tree",
      accountType: "Savings",
      accountNumber: "123456",
      accountName: "Jane Doe",
      currency: "JMD",
      setDefault: true,
    })
    expect(erp.getBankAccountsByCustomer).toHaveBeenCalledWith("CUST-1")
  })

  it("ignores an erpParty smuggled into the input", async () => {
    erp.createBankAccount.mockResolvedValue({ bankAccountId: "Jane Doe - NCB" })
    erp.getBankAccountsByCustomer.mockResolvedValue([created])

    await addBankAccount(ACCOUNT_ID, {
      ...addInput,
      erpParty: "CUST-VICTIM",
    } as typeof addInput)

    expect(erp.createBankAccount.mock.calls[0][0].erpParty).toBe("CUST-1")
  })

  it("defaults setDefault to false and omits a blank account name", async () => {
    erp.createBankAccount.mockResolvedValue({ bankAccountId: "Jane Doe - NCB" })
    erp.getBankAccountsByCustomer.mockResolvedValue([created])

    await addBankAccount(ACCOUNT_ID, {
      ...addInput,
      accountName: "  ",
      setDefault: null,
    })

    expect(erp.createBankAccount).toHaveBeenCalledWith(
      expect.objectContaining({ setDefault: false, accountName: undefined }),
    )
  })

  it.each([
    ["a blank bank name", { bankName: " " }, "Bank name is required."],
    ["a short branch", { bankBranch: "x" }, "Bank branch is required."],
    [
      "an unknown account type",
      { accountType: "Checking" },
      "Account type must be Chequing or Savings.",
    ],
    [
      "a short account number",
      { accountNumber: " 123 " },
      "A valid account number is required.",
    ],
    [
      "markup in the account number",
      { accountNumber: "12<b>34 xyz" },
      "Bank account details contain invalid characters.",
    ],
    [
      "punctuation in the account number",
      { accountNumber: "1234;5678" },
      "A valid account number is required.",
    ],
    [
      "an account number that starts with a separator",
      { accountNumber: "-1234567" },
      "A valid account number is required.",
    ],
    [
      "an account number longer than 34 characters",
      { accountNumber: "1".repeat(35) },
      "A valid account number is required.",
    ],
    [
      "a branch longer than 100 characters",
      { bankBranch: "b".repeat(101) },
      "Bank branch must be 100 characters or fewer.",
    ],
    [
      "an account name longer than 80 characters",
      { accountName: "n".repeat(81) },
      "Account name must be 80 characters or fewer.",
    ],
    [
      "angle brackets in the branch",
      { bankBranch: "Half <i>Way</i> Tree" },
      "Bank account details contain invalid characters.",
    ],
    [
      "angle brackets in the account name",
      { accountName: "Jane <script>" },
      "Bank account details contain invalid characters.",
    ],
    [
      "a control character in the branch",
      { bankBranch: "Half Way\u0000Tree" },
      "Bank account details contain invalid characters.",
    ],
    [
      "a trailing newline in the account name",
      { accountName: "Jane Doe\n" },
      "Bank account details contain invalid characters.",
    ],
    ["an unsupported bank", { bankName: "Bank of Nowhere" }, "Bank is not supported."],
    ["an unsupported currency", { currency: "CAD" }, "Currency must be JMD or USD."],
    ["a blank currency", { currency: "" }, "Currency must be JMD or USD."],
  ])("rejects %s", async (_label, override, message) => {
    const result = await addBankAccount(ACCOUNT_ID, { ...addInput, ...override })

    expect(result).toBeInstanceOf(ValidationError)
    expect((result as Error).message).toBe(message)
    expect(erp.createBankAccount).not.toHaveBeenCalled()
  })

  it("accepts USD", async () => {
    erp.createBankAccount.mockResolvedValue({ bankAccountId: "BANK-ACC-1" })

    const result = await addBankAccount(ACCOUNT_ID, { ...addInput, currency: "USD" })

    expect(result).toBe(storedBank)
    expect(erp.createBankAccount.mock.calls[0][0].currency).toBe("USD")
  })

  it("propagates a supported-banks lookup failure", async () => {
    erp.listBanks.mockResolvedValue(new BanksQueryError("boom"))

    expect(await addBankAccount(ACCOUNT_ID, addInput)).toBeInstanceOf(BanksQueryError)
    expect(erp.createBankAccount).not.toHaveBeenCalled()
  })

  it("accepts the longest values and a formatted account number", async () => {
    erp.createBankAccount.mockResolvedValue({ bankAccountId: "BANK-ACC-1" })

    const result = await addBankAccount(ACCOUNT_ID, {
      ...addInput,
      accountNumber: "GB82 WEST-1234 5698 7654 32",
      bankBranch: "b".repeat(100),
      accountName: "n".repeat(80),
    })

    expect(result).toBe(storedBank)
    expect(erp.createBankAccount.mock.calls[0][0].accountNumber).toBe(
      "GB82 WEST-1234 5698 7654 32",
    )
  })

  it("propagates a create failure from ERPNext without re-reading", async () => {
    const err = new BankAccountCreateError("boom")
    erp.createBankAccount.mockResolvedValue(err)

    expect(await addBankAccount(ACCOUNT_ID, addInput)).toBe(err)
    // Only the pre-write read (cap + own-duplicate check), no re-read.
    expect(erp.getBankAccountsByCustomer).toHaveBeenCalledTimes(1)
  })

  it(`rejects the add once the customer has ${MAX_BANK_ACCOUNTS} accounts`, async () => {
    erp.getBankAccountsByCustomer.mockResolvedValue(
      Array.from({ length: MAX_BANK_ACCOUNTS }, (_, i) => ({
        ...storedBank,
        name: `BANK-ACC-${i}`,
        bank_account_no: `90000${i}`,
      })),
    )

    const result = await addBankAccount(ACCOUNT_ID, addInput)

    expect(result).toBeInstanceOf(ValidationError)
    expect((result as Error).message).toBe(
      "You can have at most 10 bank accounts. Delete one before adding another.",
    )
    expect(erp.createBankAccount).not.toHaveBeenCalled()
  })

  it("still allows the add one below the cap", async () => {
    erp.createBankAccount.mockResolvedValue({ bankAccountId: "BANK-ACC-0" })
    erp.getBankAccountsByCustomer.mockResolvedValue(
      Array.from({ length: MAX_BANK_ACCOUNTS - 1 }, (_, i) => ({
        ...storedBank,
        name: `BANK-ACC-${i}`,
        bank_account_no: `90000${i}`,
      })),
    )

    expect(await addBankAccount(ACCOUNT_ID, addInput)).not.toBeInstanceOf(Error)
    expect(erp.createBankAccount).toHaveBeenCalledTimes(1)
  })

  it("propagates a bank account query failure before writing", async () => {
    erp.getBankAccountsByCustomer.mockResolvedValue(new BankAccountQueryError("boom"))

    expect(await addBankAccount(ACCOUNT_ID, addInput)).toBeInstanceOf(
      BankAccountQueryError,
    )
    expect(erp.createBankAccount).not.toHaveBeenCalled()
  })

  it("reports a duplicate for a number on the customer's OWN account, without asking ERPNext", async () => {
    erp.getBankAccountsByCustomer.mockResolvedValue([
      { ...storedBank, bank_account_no: "123456" },
    ])

    expect(await addBankAccount(ACCOUNT_ID, addInput)).toBeInstanceOf(
      BankAccountDuplicateNumberError,
    )
    expect(erp.createBankAccount).not.toHaveBeenCalled()
  })

  it("does not confirm that a number is on file for someone else", async () => {
    erp.createBankAccount.mockResolvedValue(new BankAccountDuplicateNumberError("dup"))

    const result = await addBankAccount(ACCOUNT_ID, addInput)

    expect(result).toBeInstanceOf(BankAccountValidationError)
    expect(result).not.toBeInstanceOf(BankAccountDuplicateNumberError)
    expect((result as Error).message).toBe(BankAccountValidationReason.NumberNotAccepted)
  })

  describe("when the create commits but the re-read fails", () => {
    beforeEach(() => {
      erp.createBankAccount.mockResolvedValue({ bankAccountId: "Jane Doe - NCB" })
    })

    it("returns the account built from the validated input, and logs", async () => {
      erp.getBankAccountsByCustomer
        .mockResolvedValueOnce([storedBank])
        .mockResolvedValueOnce(new BankAccountQueryError("boom"))

      const result = await addBankAccount(ACCOUNT_ID, addInput)

      expect(result).toEqual({
        name: "Jane Doe - NCB",
        account_name: "Jane Doe",
        bank: "NCB",
        bank_account_no: "123456",
        branch_code: "Half Way Tree",
        account_type: "Savings",
        currency: "JMD",
        is_default: 1,
      })
      expect(baseLogger.error).toHaveBeenCalledTimes(1)
    })

    it("reports a non-default account when setDefault was not asked for", async () => {
      erp.getBankAccountsByCustomer
        .mockResolvedValueOnce([storedBank])
        .mockResolvedValueOnce(new BankAccountQueryError("boom"))

      const result = await addBankAccount(ACCOUNT_ID, { ...addInput, setDefault: false })

      expect(result).toMatchObject({ name: "Jane Doe - NCB", is_default: 0 })
    })

    it("reports the first account as default, as ERPNext makes it", async () => {
      erp.getBankAccountsByCustomer
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(new BankAccountQueryError("boom"))

      const result = await addBankAccount(ACCOUNT_ID, { ...addInput, setDefault: false })

      expect(result).toMatchObject({ is_default: 1 })
    })
  })

  it("errors rather than returning a partial account when the re-read misses it", async () => {
    erp.createBankAccount.mockResolvedValue({ bankAccountId: "Jane Doe - NCB" })
    erp.getBankAccountsByCustomer.mockResolvedValue([storedBank])

    expect(await addBankAccount(ACCOUNT_ID, addInput)).toBeInstanceOf(
      BankAccountNotOwnedError,
    )
  })
})

describe("updateBankAccount", () => {
  const fresh = {
    ...storedBank,
    bank: "Scotiabank",
    branch_code: "New Kingston",
    account_type: "Chequing",
    bank_account_no: "222222",
  }

  beforeEach(() => {
    erp.updateBankAccount.mockResolvedValue(true)
    erp.getBankAccountsByCustomer
      .mockResolvedValueOnce([storedBank])
      .mockResolvedValueOnce([fresh])
  })

  it("updates with the STORED currency and returns the fresh account", async () => {
    const result = await updateBankAccount(ACCOUNT_ID, updateInput)

    expect(result).toBe(fresh)
    expect(erp.updateBankAccount).toHaveBeenCalledWith({
      bankAccountId: "BANK-ACC-1",
      erpParty: "CUST-1",
      bankName: "Scotiabank",
      bankBranch: "New Kingston",
      accountType: "Chequing",
      accountNumber: "222222",
      accountName: undefined,
      currency: "USD",
    })
    expect(erp.getBankAccountsByCustomer).toHaveBeenCalledTimes(2)
  })

  it("cannot change the currency even if the client sends one", async () => {
    await updateBankAccount(ACCOUNT_ID, {
      ...updateInput,
      currency: "JMD",
    } as typeof updateInput)

    expect(erp.updateBankAccount.mock.calls[0][0].currency).toBe("USD")
  })

  it("closes the account's open update requests after a successful update", async () => {
    erp.getOpenBankAccountUpdateRequestsForAccount.mockResolvedValue([
      { name: "BAUR-1" },
      { name: "BAUR-2" },
    ])

    const result = await updateBankAccount(ACCOUNT_ID, updateInput)

    expect(result).toBe(fresh)
    expect(erp.getOpenBankAccountUpdateRequestsForAccount).toHaveBeenCalledWith(
      "BANK-ACC-1",
    )
    expect(erp.closeBankAccountUpdateRequests).toHaveBeenCalledWith(["BAUR-1", "BAUR-2"])
    expect(erp.updateBankAccount.mock.invocationCallOrder[0]).toBeLessThan(
      erp.closeBankAccountUpdateRequests.mock.invocationCallOrder[0],
    )
  })

  it.each([
    [
      "the open-request lookup fails",
      () =>
        erp.getOpenBankAccountUpdateRequestsForAccount.mockResolvedValue(
          new BankAccountUpdateRequestQueryError("boom"),
        ),
    ],
    [
      "the close fails",
      () => {
        erp.getOpenBankAccountUpdateRequestsForAccount.mockResolvedValue([
          { name: "BAUR-1" },
        ])
        erp.closeBankAccountUpdateRequests.mockResolvedValue(
          new SetDocTypeValueError("boom"),
        )
      },
    ],
  ])("still succeeds, and logs, when %s", async (_label, arrange) => {
    arrange()

    expect(await updateBankAccount(ACCOUNT_ID, updateInput)).toBe(fresh)
    expect(baseLogger.error).toHaveBeenCalledTimes(1)
  })

  it("rejects invalid details before writing", async () => {
    const result = await updateBankAccount(ACCOUNT_ID, {
      ...updateInput,
      accountType: "Current",
    })

    expect(result).toBeInstanceOf(ValidationError)
    expect(erp.updateBankAccount).not.toHaveBeenCalled()
    expect(erp.closeBankAccountUpdateRequests).not.toHaveBeenCalled()
  })

  it("rejects an unsupported bank before writing", async () => {
    const result = await updateBankAccount(ACCOUNT_ID, {
      ...updateInput,
      bankName: "Bank of Nowhere",
    })

    expect(result).toBeInstanceOf(ValidationError)
    expect(erp.updateBankAccount).not.toHaveBeenCalled()
  })

  it("rejects an oversized branch before writing", async () => {
    const result = await updateBankAccount(ACCOUNT_ID, {
      ...updateInput,
      bankBranch: "b".repeat(101),
    })

    expect(result).toBeInstanceOf(ValidationError)
    expect(erp.updateBankAccount).not.toHaveBeenCalled()
  })

  it("reports a duplicate for a number on ANOTHER of the customer's own accounts", async () => {
    erp.getBankAccountsByCustomer.mockReset()
    erp.getBankAccountsByCustomer.mockResolvedValue([
      storedBank,
      { ...storedBank, name: "BANK-ACC-2", bank_account_no: "222222" },
    ])

    expect(await updateBankAccount(ACCOUNT_ID, updateInput)).toBeInstanceOf(
      BankAccountDuplicateNumberError,
    )
    expect(erp.updateBankAccount).not.toHaveBeenCalled()
  })

  it("lets an update keep the account's own number", async () => {
    const result = await updateBankAccount(ACCOUNT_ID, {
      ...updateInput,
      accountNumber: storedBank.bank_account_no,
    })

    expect(result).toBe(fresh)
  })

  it("does not confirm that a number is on file for someone else", async () => {
    erp.updateBankAccount.mockResolvedValue(new BankAccountDuplicateNumberError("dup"))

    const result = await updateBankAccount(ACCOUNT_ID, updateInput)

    expect(result).toBeInstanceOf(BankAccountValidationError)
    expect((result as Error).message).toBe(BankAccountValidationReason.NumberNotAccepted)
    expect(erp.closeBankAccountUpdateRequests).not.toHaveBeenCalled()
  })

  it("returns the written values when the update commits but the re-read fails", async () => {
    erp.getBankAccountsByCustomer.mockReset()
    erp.getBankAccountsByCustomer
      .mockResolvedValueOnce([{ ...storedBank, account_name: "Jane Doe" }])
      .mockResolvedValueOnce(new BankAccountQueryError("boom"))

    const result = await updateBankAccount(ACCOUNT_ID, updateInput)

    expect(result).toEqual({
      ...storedBank,
      account_name: "Jane Doe",
      bank: "Scotiabank",
      branch_code: "New Kingston",
      account_type: "Chequing",
      bank_account_no: "222222",
    })
    expect(baseLogger.error).toHaveBeenCalledTimes(1)
  })

  it("leaves pending requests alone when the ERPNext update fails", async () => {
    const err = new BankAccountUpdateError("boom")
    erp.updateBankAccount.mockResolvedValue(err)

    expect(await updateBankAccount(ACCOUNT_ID, updateInput)).toBe(err)
    expect(erp.getOpenBankAccountUpdateRequestsForAccount).not.toHaveBeenCalled()
    expect(erp.closeBankAccountUpdateRequests).not.toHaveBeenCalled()
  })
})

describe("setDefaultBankAccount", () => {
  it("sets the default and returns the fresh account", async () => {
    const fresh = { ...storedBank, is_default: 1 as const }
    erp.setDefaultBankAccount.mockResolvedValue(true)
    erp.getBankAccountsByCustomer
      .mockResolvedValueOnce([storedBank])
      .mockResolvedValueOnce([fresh])

    const result = await setDefaultBankAccount(ACCOUNT_ID, {
      bankAccountId: "BANK-ACC-1",
    })

    expect(result).toBe(fresh)
    expect(erp.setDefaultBankAccount).toHaveBeenCalledWith({
      bankAccountId: "BANK-ACC-1",
      erpParty: "CUST-1",
    })
  })

  it("returns the account as default when the write commits but the re-read fails", async () => {
    erp.setDefaultBankAccount.mockResolvedValue(true)
    erp.getBankAccountsByCustomer
      .mockResolvedValueOnce([storedBank])
      .mockResolvedValueOnce(new BankAccountQueryError("boom"))

    const result = await setDefaultBankAccount(ACCOUNT_ID, {
      bankAccountId: "BANK-ACC-1",
    })

    expect(result).toEqual({ ...storedBank, is_default: 1 })
    expect(baseLogger.error).toHaveBeenCalledTimes(1)
  })

  it("propagates the ERPNext error", async () => {
    const err = new BankAccountSetDefaultError("boom")
    erp.setDefaultBankAccount.mockResolvedValue(err)

    expect(await setDefaultBankAccount(ACCOUNT_ID, { bankAccountId: "BANK-ACC-1" })).toBe(
      err,
    )
    expect(erp.getBankAccountsByCustomer).toHaveBeenCalledTimes(1)
  })
})

describe("deleteBankAccount", () => {
  it("deletes an owned account", async () => {
    erp.deleteBankAccount.mockResolvedValue({
      bankAccountId: "BANK-ACC-1",
      deleted: false,
      disabled: true,
      newDefault: null,
    })

    const result = await deleteBankAccount(ACCOUNT_ID, { bankAccountId: "BANK-ACC-1" })

    expect(result).toBe(true)
    expect(erp.deleteBankAccount).toHaveBeenCalledWith({
      bankAccountId: "BANK-ACC-1",
      erpParty: "CUST-1",
    })
  })

  it("propagates the ERPNext error", async () => {
    const err = new BankAccountDeleteError("boom")
    erp.deleteBankAccount.mockResolvedValue(err)

    expect(await deleteBankAccount(ACCOUNT_ID, { bankAccountId: "BANK-ACC-1" })).toBe(err)
  })
})
