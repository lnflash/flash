import { AccountsRepository, UsersRepository } from "@services/mongoose"
import { IdentityRepository } from "@services/kratos"
import ErpNext from "@services/frappe/ErpNext"

import { AccountUpgradeRequest, RequestStatus } from "@services/frappe/models/AccountUpgradeRequest"
import { DomainError, ValidationError } from "@domain/shared"
import { AccountLevel } from "@domain/accounts"
import { SetDocTypeValueError, UpgradeRequestQueryError } from "@services/frappe/errors"
import { SearchFilter } from "@services/frappe/SearchFilters"


type RequestId = string & { __brand: "UpgradeRequestId" }
type UpgradeStatusResponse = {
  id: RequestId
  status: RequestStatus
}

export class CreateUpgradeRequestError extends DomainError {}

export type Address = {
  title: string,
  line1: string
  line2?: string
  city: string
  state: string
  postalCode?: string
  country: string // Should fetch from ErpNext options
}

export type BankAccount = {
  bankName: string
  bankBranch: string
  accountType: string
  currency: string
  accountNumber: string
}

type ProUpgradeRequest = {
  level: typeof AccountLevel.Pro
  accountId: AccountId
  fullName: string
  address: Address
  terminalsRequested: number
  bankAccount?: BankAccount
  idDocument: string
}

type MerchantUpgradeRequest = {
  level: typeof AccountLevel.Merchant
  accountId: AccountId
  fullName: string
  address: Address
  terminalsRequested: number
  bankAccount: BankAccount
  idDocument: string
}

type UpgradeRequest = ProUpgradeRequest | MerchantUpgradeRequest

export const createUpgradeRequest = async (
  accountId: AccountId,
  input: UpgradeRequest,
): Promise<UpgradeStatusResponse | ApplicationError> => {
  const accountsRepo = AccountsRepository()
  const usersRepo = UsersRepository()

  const account = await accountsRepo.findById(accountId)
  if (account instanceof Error) return account


  const user = await usersRepo.findById(account.kratosUserId)
  if (user instanceof Error) return user

  const identity = await IdentityRepository().getIdentity(account.kratosUserId)
  if (identity instanceof Error) return identity

  const context = { account, user, kratos: identity }

  const pendingRequests = await ErpNext.getAccountUpgradeRequestList({ 
    username: SearchFilter.Eq(account.username),
    status: SearchFilter.Eq(RequestStatus.Pending)
  })
  if (pendingRequests instanceof UpgradeRequestQueryError) return pendingRequests
  
  const closeResp = await ErpNext.closeAccountUpgradeRequests(pendingRequests)
  if (closeResp instanceof SetDocTypeValueError) return closeResp

  const initialStatus = RequestStatus.Pending
  const req = await new AccountUpgradeRequest(
    "", // name - assigned by ERPNext
    account.username as Username,
    account.level,
    input.level as AccountLevel,
    initialStatus,
    input.fullName,
    user.phone as PhoneNumber,
    identity.email as EmailAddress,
    input.idDocument,
    input.address,
    input.terminalsRequested,
    input.bankAccount,
  ).validate(context)
  if (Array.isArray(req)) return new ValidationError(req)

  const requestResult = await ErpNext.postUpgradeRequest(req)
  if (requestResult instanceof Error) return requestResult

  return { id: requestResult.name, status: initialStatus } as UpgradeStatusResponse
}
