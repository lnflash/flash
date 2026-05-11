export type BankAccount = {
  name?: string
  account_name?: string
  bank: string
  bank_account_no: string
  branch_code: string
  account_type: string
  currency: string
  party_type?: string
  party?: string
  is_default?: 0 | 1
}
