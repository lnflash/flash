type AccountError = import("./errors").AccountError

type CurrencyRatio = number & { readonly brand: unique symbol }
type AccountLevel =
  (typeof import("./index").AccountLevel)[keyof typeof import("./index").AccountLevel]

type AccountStatus =
  (typeof import("./index").AccountStatus)[keyof typeof import("./index").AccountStatus]

type AccountLimitsRange =
  (typeof import("./index").AccountLimitsRange)[keyof typeof import("./index").AccountLimitsRange]

type AccountLimitsType =
  (typeof import("./index").AccountLimitsType)[keyof typeof import("./index").AccountLimitsType]

type DepositFeeRatioAsBasisPoints = bigint & { readonly brand: unique symbol }

type ContactAlias = string & { readonly brand: unique symbol }

type AccountLimitsArgs = {
  level: AccountLevel
  accountLimits?: {
    intraLedger: {
      level: {
        [l: number]: number
      }
    }
    withdrawal: {
      level: {
        [l: number]: number
      }
    }
    tradeIntraAccount: {
      level: {
        [l: number]: number
      }
    }
  }
}

interface IAccountLimits {
  intraLedgerLimit: UsdCents
  withdrawalLimit: UsdCents
  tradeIntraAccountLimit: UsdCents
}

type IAccountLimitAmounts = { [key in keyof IAccountLimits]: UsdPaymentAmount }

type AccountContact = {
  readonly id: Username
  readonly username: Username
  alias: ContactAlias
  transactionsCount: number
}

type AccountStatusHistory = Array<{
  status: AccountStatus
  updatedAt?: Date
  updatedByUserId?: UserId
  comment?: string
}>

type Account = {
  readonly id: AccountId
  readonly uuid: AccountUuid
  readonly createdAt: Date
  username: Username
  npub: Npub
  defaultWalletId: WalletId
  withdrawFee: Satoshis // TODO: make it optional. only save when not default value from yaml
  level: AccountLevel
  status: AccountStatus
  statusHistory: AccountStatusHistory
  title: BusinessMapTitle | null
  coordinates: Coordinates | null
  contactEnabled: boolean
  readonly contacts: AccountContact[]
  readonly isEditor: boolean
  readonly quizQuestions: UserQuizQuestion[] // deprecated
  readonly quiz: Quiz[]
  notificationSettings: NotificationSettings
  kratosUserId: UserId
  displayCurrency: DisplayCurrency
  // temp
  role?: string

  /**
   * CASHIER_ROLE: Cashier-specific authentication fields
   *
   * Purpose: Support PIN-based authentication and permission management for cashiers.
   * These fields are only populated for accounts with cashier role.
   *
   * Security: PIN fields must never be exposed in API responses.
   *
   * @added cashier-role-v1
   * @security-review pending
   * @milestone 1
   */

  /** Bcrypt hash of cashier PIN - only for cashier role */
  pinHash?: string

  /** When the PIN was created */
  pinCreatedAt?: Date

  /** Last successful PIN usage */
  pinLastUsedAt?: Date

  /** Failed PIN attempts counter */
  pinFailedAttempts?: number

  /** Account locked until this time due to failed attempts */
  pinLockedUntil?: Date

  /** Last authentication method used */
  lastLoginMethod?: "phone" | "email" | "pin"

  /** Cashier permissions array - empty for non-cashier roles */
  cashierPermissions?: CashierPermission[]

  /** Terminal ID for location-bound sessions */
  terminalId?: string
}

// deprecated
type QuizQuestion = {
  readonly id: QuizQuestionId
  readonly earnAmount: Satoshis
}

// deprecated
type UserQuizQuestion = {
  readonly question: QuizQuestion
  completed: boolean
}

type Quiz = {
  readonly id: QuizQuestionId
  readonly amount: Satoshis
  readonly completed: boolean
}

// type BusinessMapTitle = string & { readonly brand: unique symbol }
// type Coordinates = {
//   longitude: number
//   latitude: number
// }

// type BusinessMapInfo = {
//   title: BusinessMapTitle
//   coordinates: Coordinates
// }

// type BusinessMapMarker = {
//   username: Username
//   mapInfo: BusinessMapInfo
// }

type LimiterCheckInputs = {
  amount: UsdPaymentAmount
  walletVolumes: TxBaseVolumeAmount<WalletCurrency>[]
}

type LimitsCheckerFn = (args: LimiterCheckInputs) => Promise<true | LimitsExceededError>

type LimitsVolumesFn = (walletVolumes: TxBaseVolumeAmount<WalletCurrency>[]) => Promise<
  | {
      volumeTotalLimit: UsdPaymentAmount
      volumeUsed: UsdPaymentAmount
      volumeRemaining: UsdPaymentAmount
    }
  | ValidationError
>

type AccountLimitsChecker = {
  checkIntraledger: LimitsCheckerFn
  checkWithdrawal: LimitsCheckerFn
  checkTradeIntraAccount: LimitsCheckerFn
}

type AccountLimitsVolumes =
  | {
      volumesIntraledger: LimitsVolumesFn
      volumesWithdrawal: LimitsVolumesFn
      volumesTradeIntraAccount: LimitsVolumesFn
    }
  | ValidationError

type AccountValidator = {
  isActive(): true | ValidationError
  isLevel(accountLevel: number): true | ValidationError
  validateWalletForAccount(wallet: Wallet): true | ValidationError
}

interface IAccountsRepository {
  listUnlockedAccounts(): AsyncGenerator<Account> | RepositoryError
  findById(accountId: AccountId): Promise<Account | RepositoryError>
  findByUserId(kratosUserId: UserId): Promise<Account | RepositoryError>
  findByUuid(accountUuid: AccountUuid): Promise<Account | RepositoryError>

  persistNew(kratosUserId: UserId): Promise<Account | RepositoryError>

  findByUsername(username: Username): Promise<Account | RepositoryError>
  // listBusinessesForMap(): Promise<BusinessMapMarker[] | RepositoryError>
  findByNpub(npub: Npub): Promise<Account | RepositoryError>
  update(account: Account): Promise<Account | RepositoryError>
}

type AdminRole = "dealer" | "funder" | "bankowner" | "editor" | "cashier"
type AdminAccount = {
  role: AdminRole
  phone: PhoneNumber
}

type TestAccount = {
  phone: PhoneNumber
  code: PhoneCode
}

type TestAccountsChecker = (testAccounts: TestAccount[]) => {
  isPhoneValid: (phone: PhoneNumber) => boolean
  isPhoneAndCodeValid: ({
    code,
    phone,
  }: {
    code: PhoneCode
    phone: PhoneNumber
  }) => boolean
}

type FeesConfig = {
  depositRatioAsBasisPoints: DepositFeeRatioAsBasisPoints
  depositThreshold: BtcPaymentAmount
  depositDefaultMin: BtcPaymentAmount
  withdrawMethod: WithdrawalFeePriceMethod
  withdrawRatioAsBasisPoints: bigint
  withdrawThreshold: Satoshis
  withdrawDaysLookback: Days
  withdrawDefaultMin: Satoshis
}
