import { BankAccount } from "@services/frappe/models/BankAccount"
import {
  BankAccountUpdateRequest,
  ErpNextBankAccountUpdateRequestData,
} from "@services/frappe/models/BankAccountUpdateRequest"
import { RequestStatus } from "@services/frappe/models/AccountUpgradeRequest"

const newBankAccount: BankAccount = {
  bank: "Scotiabank",
  branch_code: "New Kingston",
  account_type: "Chequing",
  currency: "JMD",
  bank_account_no: "0987654321",
}

const erpResponse: ErpNextBankAccountUpdateRequestData = {
  name: "BAUR-0001",
  party: "CUST-042",
  bank_account: "BANK-ACC-7",
  status: "Pending",
  bank_name: "Scotiabank",
  bank_branch: "New Kingston",
  account_type: "Chequing",
  currency: "JMD",
  account_number: "0987654321",
  support_note: "",
}

describe("BankAccountUpdateRequest", () => {
  describe("toErpnext", () => {
    it("serializes to the ERPNext shape", () => {
      const req = new BankAccountUpdateRequest(
        "",
        "CUST-042",
        "BANK-ACC-7",
        RequestStatus.Pending,
        newBankAccount,
      )

      expect(req.toErpnext()).toMatchObject({
        doctype: "Bank Account Update Request",
        party: "CUST-042",
        bank_account: "BANK-ACC-7",
        status: "Pending",
        bank_name: "Scotiabank",
        bank_branch: "New Kingston",
        account_type: "Chequing",
        currency: "JMD",
        account_number: "0987654321",
      })
    })
  })

  describe("fromErpnext", () => {
    it("deserializes from the ERPNext shape", () => {
      const req = BankAccountUpdateRequest.fromErpnext(erpResponse)

      expect(req.name).toBe("BAUR-0001")
      expect(req.party).toBe("CUST-042")
      expect(req.bankAccountId).toBe("BANK-ACC-7")
      expect(req.status).toBe("Pending")
      expect(req.newBankAccount).toEqual(newBankAccount)
    })

    it("defaults party to empty string when absent", () => {
      const req = BankAccountUpdateRequest.fromErpnext({
        ...erpResponse,
        party: undefined,
      })

      expect(req.party).toBe("")
    })
  })
})
