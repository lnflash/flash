type AccountError = import("./errors").AccountError

type BridgeCustomerId = import("@domain/primitives/bridge").BridgeCustomerId

type CurrencyRatio = number & { readonly brand: unique symbol }
type AccountLevel =
  (typeof import("./index").AccountLevel)[keyof typeof import("./index").AccountLevel]

type AccountStatus =
  (typeof import("./index").AccountStatus)[keyof typeof import("./index").AccountStatus]

type AccountStatusHeadline =
  (typeof import("./index").AccountStatusHeadline)[keyof typeof import("./index").AccountStatusHeadline]

type RequestableCapability =
  (typeof import("./index").RequestableCapability)[keyof typeof import("./index").RequestableCapability]

type AccountCapabilities = {
  readonly verified: boolean
  readonly bankPayout: boolean
  readonly business: boolean
  readonly usdAccount: boolean
}

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
  // Optional: an account holds an npub only once it links one, and `releaseNpub`
  // takes it back off.
  npub?: Npub
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
  erpParty?: string // Lookup key to Customer in ERPNext. Required for Account level > 1
  // Bridge integration:
  bridgeCustomerId?: BridgeCustomerId
  bridgeKycStatus?:
    | "open"
    | "not_started"
    | "incomplete"
    | "awaiting_questionnaire"
    | "awaiting_ubo"
    | "under_review"
    | "paused"
    | "approved"
    | "rejected"
    | "offboarded"
  bridgeEthereumAddress?: string
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

// `unsetNpub` reads the pre-update document to decide whether anything was
// actually freed, so it is the only place the removed npub still exists — the
// updated document no longer carries it. Handing it back saves the caller a
// second read that could disagree with what the `$unset` removed.
type NpubUnset = {
  account: Account
  previousNpub: Npub
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
  unsetNpub(accountId: AccountId): Promise<NpubUnset | RepositoryError>
  // `AccountAlreadyHasNpubError` in the union is the write-time guard: the
  // caller's "target holds no npub" check is a read from before the release,
  // and a key the target claims in that window must refuse the reassignment
  // rather than be silently overwritten.
  claimNpub(
    accountId: AccountId,
    npub: Npub,
  ): Promise<Account | RepositoryError | AccountAlreadyHasNpubError>
  update(account: Account): Promise<Account | RepositoryError>

  transitionBridgeKycStatus(
    id: AccountId,
    nextStatus:
      | "open"
      | "not_started"
      | "incomplete"
      | "awaiting_questionnaire"
      | "awaiting_ubo"
      | "under_review"
      | "paused"
      | "approved"
      | "rejected"
      | "offboarded",
  ): Promise<
    { changed: boolean; previousStatus?: Account["bridgeKycStatus"] } | RepositoryError
  >
  updateBridgeFields(
    id: AccountId,
    fields: {
      bridgeCustomerId?: BridgeCustomerId
      bridgeKycStatus?:
        | "open"
        | "not_started"
        | "incomplete"
        | "awaiting_questionnaire"
        | "awaiting_ubo"
        | "under_review"
        | "paused"
        | "approved"
        | "rejected"
        | "offboarded"
      bridgeEthereumAddress?: string
    },
  ): Promise<Account | RepositoryError>

  findByBridgeEthereumAddress(address: string): Promise<Account | RepositoryError>

  findByBridgeCustomerId(customerId: BridgeCustomerId): Promise<Account | RepositoryError>

  findByRole(role: string): Promise<Account | RepositoryError>
}

type AdminRole = "dealer" | "funder" | "bankowner" | "editor" | "rewards"
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
