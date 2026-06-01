import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"

import { CashWalletCutoverDiscovery } from "./discovery"
import { CashWalletCutoverPreflightReport } from "./preflight"

export type CashWalletCutoverOperatorManifestAccount = {
  batchRunId?: string
  index?: number
  phone?: string
  username?: string
  accountId: AccountId
  accountUuid?: AccountUuid
  expectedUsdWalletId?: WalletId
  expectedUsdtWalletId?: WalletId
}

export type OperatorBalanceStatus = "loading" | "fresh" | "error"

export type OperatorBalance = {
  currency: WalletCurrency
  display: string
  minorUnits: string
  minorUnitsNumber: number
  status?: OperatorBalanceStatus
  error?: string
}

export type OperatorWallet = {
  id: WalletId
  currency: WalletCurrency
  expected: boolean
  balance: OperatorBalance
}

export type OperatorAccount = {
  batchRunId?: string
  index?: number
  phone?: string
  username?: string
  accountId: AccountId
  accountUuid?: AccountUuid
  expectedUsdWalletId?: WalletId
  expectedUsdtWalletId?: WalletId
  watchlisted: boolean
  defaultWalletId?: WalletId
  defaultWalletCurrency?: WalletCurrency
  walletCount: number
  usdWallets: OperatorWallet[]
  usdtWallets: OperatorWallet[]
  migrationStatus: CashWalletMigrationStatus | "none"
  migrationUpdatedAt?: string
  cutoverBalanceAudit?: OperatorCutoverBalanceAudit
  anomalies: string[]
}

export type OperatorCutoverBalanceAudit = {
  status: "loading" | "shortfall" | "verified"
  sourceUsdCents: number
  expectedMinimumUsdtMicros: number
  destinationStartingBalanceUsdtMicros: number
  currentDestinationBalanceUsdtMicros: number
  finalDeltaUsdtMicros: number
  roundingSubsidyUsdtMicros: number
  shortfallUsdtMicros: number
}

export type OperatorTreasuryAccount = {
  accountId: AccountId
  accountUuid?: AccountUuid
  role?: string
  defaultWalletId?: WalletId
  defaultWalletCurrency?: WalletCurrency
  walletCount: number
  usdWallets: OperatorWallet[]
  usdtWallets: OperatorWallet[]
  anomalies: string[]
}

export type OperatorTreasurySummary = {
  accounts: number
  wallets: number
  usdTotalCents: number
  usdtTotalMicros: number
}

export type OperatorReconciliationSummary = {
  customerTotalCents: number
  treasuryTotalCents: number
  systemTotalCents: number
}

export type CashWalletCutoverOperatorSnapshot = {
  generatedAt: string
  cutover: {
    state: CashWalletCutoverState
    cutoverVersion: number
    runId?: string
    updatedAt?: string
  }
  preflight?: CashWalletCutoverPreflightReport
  summary: {
    accounts: number
    wallets: {
      current: number
      target: number
      usd: number
      usdt: number
      missingUsdt: number
    }
    fundedUsdOnlyAccounts: number
    usdTotalCents: number
    usdtTotalMicros: number
    anomalies: number
    watchlistAnomalies: number
    canStart: boolean
    blockers: number
    watchlistAccounts: number
    migrationStatuses: Record<string, number>
  }
  accounts: OperatorAccount[]
  treasury: {
    accounts: OperatorTreasuryAccount[]
    summary: OperatorTreasurySummary
  }
  reconciliation: OperatorReconciliationSummary
}

type AccountManifestRecord = {
  index?: number
  phone?: string
  username?: string
  accountId?: string
  account?: { id?: string }
  id?: string
  accountUuid?: string
  usdWalletId?: string
  usdtWalletId?: string
}

type ManifestShape = {
  runId?: string
  accounts?: AccountManifestRecord[]
  created?: AccountManifestRecord[]
}

type BuildSnapshotArgs = {
  manifestAccounts: CashWalletCutoverOperatorManifestAccount[]
  discoveredAccounts?: CashWalletCutoverDiscovery[]
  accountsRepo: Pick<IAccountsRepository, "findById">
  walletsRepo: Pick<IWalletsRepository, "listByAccountId">
  migrationsRepo: {
    getConfig: () => Promise<CashWalletCutoverConfig | RepositoryError>
    findMigrationByAccountId: (args: {
      accountId: AccountId
      cutoverVersion: number
      runId: string
    }) => Promise<CashWalletMigration | RepositoryError | null>
  }
  getBalanceForWallet: (args: {
    walletId: WalletId
    currency?: WalletCurrency
  }) => Promise<USDAmount | USDTAmount | ApplicationError>
  migrationLookup?: {
    cutoverVersion: number
    runId: string
  }
  preflightReport?: CashWalletCutoverPreflightReport
  balanceReadAttempts?: number
  balanceMode?: "live" | "structural"
  treasuryAccountIds?: AccountId[]
  now?: Date
}

export const parseCashWalletCutoverOperatorManifest = (
  input: ManifestShape | AccountManifestRecord[],
): CashWalletCutoverOperatorManifestAccount[] => {
  const batchRunId = Array.isArray(input) ? undefined : input.runId
  const records = Array.isArray(input) ? input : (input.accounts ?? input.created ?? [])

  const accounts = records.map((record) => {
    const accountId = record.accountId ?? record.account?.id ?? record.id
    if (!accountId) {
      throw new Error("Operator manifest record is missing accountId")
    }

    return {
      batchRunId,
      index: record.index,
      phone: record.phone,
      username: record.username,
      accountId: accountId as AccountId,
      accountUuid: record.accountUuid as AccountUuid | undefined,
      expectedUsdWalletId: record.usdWalletId as WalletId | undefined,
      expectedUsdtWalletId: record.usdtWalletId as WalletId | undefined,
    }
  })

  const seen = new Set<AccountId>()
  for (const account of accounts) {
    if (seen.has(account.accountId)) {
      throw new Error(`Duplicate operator manifest accountId: ${account.accountId}`)
    }
    seen.add(account.accountId)
  }

  return accounts
}

const csvHeaders = [
  "generatedAt",
  "cutoverState",
  "cutoverVersion",
  "cutoverRunId",
  "cutoverUpdatedAt",
  "watchlisted",
  "batchRunId",
  "index",
  "phone",
  "username",
  "accountId",
  "accountUuid",
  "defaultWalletId",
  "defaultWalletCurrency",
  "expectedUsdWalletId",
  "expectedUsdtWalletId",
  "walletCount",
  "usdWalletIds",
  "usdBalanceDisplays",
  "usdBalanceMinorUnits",
  "usdBalanceStatuses",
  "usdtWalletIds",
  "usdtBalanceDisplays",
  "usdtBalanceMinorUnits",
  "usdtBalanceStatuses",
  "migrationStatus",
  "migrationUpdatedAt",
  "cutoverBalanceAudit",
  "anomalies",
]

const csvValue = (value: unknown): string => {
  if (value === undefined || value === null) return ""
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const walletIdsCsv = (wallets: OperatorWallet[]) =>
  wallets.map((wallet) => wallet.id).join(";")

const walletBalanceDisplaysCsv = (wallets: OperatorWallet[]) =>
  wallets.map((wallet) => wallet.balance.display).join(";")

const walletBalanceMinorUnitsCsv = (wallets: OperatorWallet[]) =>
  wallets.map((wallet) => wallet.balance.minorUnits).join(";")

const walletBalanceStatusesCsv = (wallets: OperatorWallet[]) =>
  wallets.map((wallet) => wallet.balance.status ?? "").join(";")

const cutoverBalanceAuditCsv = (audit?: OperatorCutoverBalanceAudit) => {
  if (!audit) return ""
  return [
    `status=${audit.status}`,
    `expectedMinimumUsdtMicros=${audit.expectedMinimumUsdtMicros}`,
    `finalDeltaUsdtMicros=${audit.finalDeltaUsdtMicros}`,
    `roundingSubsidyUsdtMicros=${audit.roundingSubsidyUsdtMicros}`,
    `shortfallUsdtMicros=${audit.shortfallUsdtMicros}`,
  ].join(";")
}

export const formatCashWalletCutoverOperatorSnapshotCsv = (
  snapshot: CashWalletCutoverOperatorSnapshot,
): string => {
  const rows = snapshot.accounts.map((account) =>
    [
      snapshot.generatedAt,
      snapshot.cutover.state,
      snapshot.cutover.cutoverVersion,
      snapshot.cutover.runId,
      snapshot.cutover.updatedAt,
      account.watchlisted,
      account.batchRunId,
      account.index,
      account.phone,
      account.username,
      account.accountId,
      account.accountUuid,
      account.defaultWalletId,
      account.defaultWalletCurrency,
      account.expectedUsdWalletId,
      account.expectedUsdtWalletId,
      account.walletCount,
      walletIdsCsv(account.usdWallets),
      walletBalanceDisplaysCsv(account.usdWallets),
      walletBalanceMinorUnitsCsv(account.usdWallets),
      walletBalanceStatusesCsv(account.usdWallets),
      walletIdsCsv(account.usdtWallets),
      walletBalanceDisplaysCsv(account.usdtWallets),
      walletBalanceMinorUnitsCsv(account.usdtWallets),
      walletBalanceStatusesCsv(account.usdtWallets),
      account.migrationStatus,
      account.migrationUpdatedAt,
      cutoverBalanceAuditCsv(account.cutoverBalanceAudit),
      account.anomalies.join(";"),
    ].map(csvValue),
  )

  return [csvHeaders, ...rows].map((row) => row.join(",")).join("\n")
}

const describeError = (error: Error): string => {
  const message = error.message?.split("\n")[0]?.trim()
  if (message) return message

  if (error.name && error.name !== "Error") return error.name

  const rendered = String(error)
  return rendered && rendered !== "[object Object]" ? rendered : "Unknown error"
}

const balanceError = (wallet: Wallet, error: Error): OperatorBalance => ({
  currency: wallet.currency,
  display: "error",
  minorUnits: "0",
  minorUnitsNumber: 0,
  status: "error",
  error: describeError(error),
})

export const formatOperatorBalance = (
  wallet: Wallet,
  balance: USDAmount | USDTAmount | ApplicationError,
): OperatorBalance => {
  if (balance instanceof Error) return balanceError(wallet, balance)

  if (wallet.currency === WalletCurrency.Usdt && balance instanceof USDTAmount) {
    const micros = balance.asSmallestUnits()
    return {
      currency: WalletCurrency.Usdt,
      display: `${(Number(micros) / 1_000_000).toFixed(2)} USDT`,
      minorUnits: micros,
      minorUnitsNumber: Number(micros),
      status: "fresh",
    }
  }

  if (wallet.currency === WalletCurrency.Usd && balance instanceof USDAmount) {
    const cents = balance.asCents()
    return {
      currency: WalletCurrency.Usd,
      display: `$${balance.asDollars(2)}`,
      minorUnits: cents,
      minorUnitsNumber: Number(cents),
      status: "fresh",
    }
  }

  return {
    currency: wallet.currency,
    display: "unexpected currency",
    minorUnits: "0",
    minorUnitsNumber: 0,
    status: "error",
    error: `Expected ${wallet.currency} balance`,
  }
}

const loadingBalance = (wallet: Wallet): OperatorBalance => ({
  currency: wallet.currency,
  display: "loading",
  minorUnits: "0",
  minorUnitsNumber: 0,
  status: "loading",
})

const summarizeWallet = async ({
  wallet,
  expectedWalletId,
  getBalanceForWallet,
  balanceReadAttempts,
  balanceMode,
}: {
  wallet: Wallet
  expectedWalletId?: WalletId
  getBalanceForWallet: BuildSnapshotArgs["getBalanceForWallet"]
  balanceReadAttempts: number
  balanceMode: BuildSnapshotArgs["balanceMode"]
}): Promise<OperatorWallet> => {
  if (balanceMode === "structural") {
    return {
      id: wallet.id,
      currency: wallet.currency,
      expected: expectedWalletId === undefined || expectedWalletId === wallet.id,
      balance: loadingBalance(wallet),
    }
  }

  let balance: USDAmount | USDTAmount | ApplicationError = new Error(
    "Balance read was not attempted",
  ) as ApplicationError

  for (let attempt = 0; attempt < balanceReadAttempts; attempt++) {
    balance = await getBalanceForWallet({
      walletId: wallet.id,
      currency: wallet.currency,
    })
    if (!(balance instanceof Error)) break
  }

  return {
    id: wallet.id,
    currency: wallet.currency,
    expected: expectedWalletId === undefined || expectedWalletId === wallet.id,
    balance: formatOperatorBalance(wallet, balance),
  }
}

const increment = (record: Record<string, number>, key: string) => {
  record[key] = (record[key] ?? 0) + 1
}

const accountsForDashboard = ({
  manifestAccounts,
  discoveredAccounts,
}: {
  manifestAccounts: CashWalletCutoverOperatorManifestAccount[]
  discoveredAccounts?: CashWalletCutoverDiscovery[]
}): OperatorAccountInput[] => {
  const manifestByAccountId = new Map(
    manifestAccounts.map((account) => [account.accountId, account]),
  )

  if (!discoveredAccounts) {
    return manifestAccounts.map((account) => ({ ...account, watchlisted: true }))
  }

  const merged = discoveredAccounts.map((discovery) => {
    const manifestAccount = manifestByAccountId.get(discovery.accountId)
    return {
      ...manifestAccount,
      accountId: discovery.accountId,
      accountUuid: manifestAccount?.accountUuid ?? discovery.accountUuid,
      expectedUsdWalletId:
        manifestAccount?.expectedUsdWalletId ?? discovery.legacyUsdWalletId,
      expectedUsdtWalletId:
        manifestAccount?.expectedUsdtWalletId ?? discovery.destinationUsdtWalletId,
      watchlisted: manifestAccount !== undefined,
    }
  })

  const discoveredAccountIds = new Set(merged.map((account) => account.accountId))
  const missingManifestAccounts = manifestAccounts
    .filter((account) => !discoveredAccountIds.has(account.accountId))
    .map((account) => ({ ...account, watchlisted: true }))

  return [...merged, ...missingManifestAccounts]
}

type OperatorAccountInput = CashWalletCutoverOperatorManifestAccount & {
  watchlisted: boolean
}

const usdTotalCentsForAccounts = (
  accounts: Array<{ usdWallets: OperatorWallet[] }>,
): number =>
  accounts.reduce(
    (sum, account) =>
      sum +
      account.usdWallets.reduce(
        (walletSum, wallet) => walletSum + wallet.balance.minorUnitsNumber,
        0,
      ),
    0,
  )

const usdtTotalMicrosForAccounts = (
  accounts: Array<{ usdtWallets: OperatorWallet[] }>,
): number =>
  accounts.reduce(
    (sum, account) =>
      sum +
      account.usdtWallets.reduce(
        (walletSum, wallet) => walletSum + wallet.balance.minorUnitsNumber,
        0,
      ),
    0,
  )

const parseIntegerAmount = (value?: string): number | undefined => {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  return Number(value)
}

const computeCutoverBalanceAudit = ({
  migration,
  usdtWallets,
}: {
  migration?: CashWalletMigration | null
  usdtWallets: OperatorWallet[]
}): OperatorCutoverBalanceAudit | undefined => {
  if (!migration || migration.status !== "complete") return undefined

  const sourceUsdCents = parseIntegerAmount(migration.sourceBalanceUsdCents)
  const expectedMinimumUsdtMicros = parseIntegerAmount(
    migration.destinationAmountUsdtMicros,
  )
  const destinationStartingBalanceUsdtMicros = parseIntegerAmount(
    migration.destinationStartingBalanceUsdtMicros,
  )

  if (
    sourceUsdCents === undefined ||
    expectedMinimumUsdtMicros === undefined ||
    destinationStartingBalanceUsdtMicros === undefined
  ) {
    return undefined
  }

  const destinationWallet = usdtWallets.find(
    (wallet) => wallet.id === migration.destinationUsdtWalletId,
  )
  if (!destinationWallet) return undefined

  if (destinationWallet.balance.status === "loading") {
    return {
      status: "loading",
      sourceUsdCents,
      expectedMinimumUsdtMicros,
      destinationStartingBalanceUsdtMicros,
      currentDestinationBalanceUsdtMicros: 0,
      finalDeltaUsdtMicros: 0,
      roundingSubsidyUsdtMicros: 0,
      shortfallUsdtMicros: 0,
    }
  }

  const currentDestinationBalanceUsdtMicros =
    destinationWallet.balance.minorUnitsNumber
  const finalDeltaUsdtMicros = Math.max(
    0,
    currentDestinationBalanceUsdtMicros - destinationStartingBalanceUsdtMicros,
  )
  const shortfallUsdtMicros = Math.max(
    0,
    expectedMinimumUsdtMicros - finalDeltaUsdtMicros,
  )
  const roundingSubsidyUsdtMicros = Math.max(
    0,
    finalDeltaUsdtMicros - expectedMinimumUsdtMicros,
  )

  return {
    status: shortfallUsdtMicros > 0 ? "shortfall" : "verified",
    sourceUsdCents,
    expectedMinimumUsdtMicros,
    destinationStartingBalanceUsdtMicros,
    currentDestinationBalanceUsdtMicros,
    finalDeltaUsdtMicros,
    roundingSubsidyUsdtMicros,
    shortfallUsdtMicros,
  }
}

export const refreshOperatorAccountCutoverBalanceAudit = <
  T extends {
    expectedUsdtWalletId?: WalletId
    usdtWallets: OperatorWallet[]
    cutoverBalanceAudit?: OperatorCutoverBalanceAudit
  },
>(
  account: T,
): T => {
  const audit = account.cutoverBalanceAudit
  if (!audit) return account

  const destinationWallet =
    account.usdtWallets.find((wallet) => wallet.id === account.expectedUsdtWalletId) ??
    account.usdtWallets.find((wallet) => wallet.expected) ??
    account.usdtWallets[0]
  if (!destinationWallet) return account

  if (destinationWallet.balance.status === "loading") {
    return {
      ...account,
      cutoverBalanceAudit: {
        ...audit,
        status: "loading",
        currentDestinationBalanceUsdtMicros: 0,
        finalDeltaUsdtMicros: 0,
        roundingSubsidyUsdtMicros: 0,
        shortfallUsdtMicros: 0,
      },
    }
  }

  const currentDestinationBalanceUsdtMicros =
    destinationWallet.balance.minorUnitsNumber
  const finalDeltaUsdtMicros = Math.max(
    0,
    currentDestinationBalanceUsdtMicros -
      audit.destinationStartingBalanceUsdtMicros,
  )
  const shortfallUsdtMicros = Math.max(
    0,
    audit.expectedMinimumUsdtMicros - finalDeltaUsdtMicros,
  )
  const roundingSubsidyUsdtMicros = Math.max(
    0,
    finalDeltaUsdtMicros - audit.expectedMinimumUsdtMicros,
  )

  return {
    ...account,
    cutoverBalanceAudit: {
      ...audit,
      status: shortfallUsdtMicros > 0 ? "shortfall" : "verified",
      currentDestinationBalanceUsdtMicros,
      finalDeltaUsdtMicros,
      roundingSubsidyUsdtMicros,
      shortfallUsdtMicros,
    },
  }
}

const combinedTotalCents = ({
  usdTotalCents,
  usdtTotalMicros,
}: {
  usdTotalCents: number
  usdtTotalMicros: number
}) => usdTotalCents + usdtTotalMicros / 10_000

const treasurySummary = (
  accounts: OperatorTreasuryAccount[],
): OperatorTreasurySummary => ({
  accounts: accounts.length,
  wallets: accounts.reduce((sum, account) => sum + account.walletCount, 0),
  usdTotalCents: usdTotalCentsForAccounts(accounts),
  usdtTotalMicros: usdtTotalMicrosForAccounts(accounts),
})

const reconciliationSummary = ({
  customerUsdTotalCents,
  customerUsdtTotalMicros,
  treasury,
}: {
  customerUsdTotalCents: number
  customerUsdtTotalMicros: number
  treasury: OperatorTreasurySummary
}): OperatorReconciliationSummary => {
  const customerTotalCents = combinedTotalCents({
    usdTotalCents: customerUsdTotalCents,
    usdtTotalMicros: customerUsdtTotalMicros,
  })
  const treasuryTotalCents = combinedTotalCents({
    usdTotalCents: treasury.usdTotalCents,
    usdtTotalMicros: treasury.usdtTotalMicros,
  })
  return {
    customerTotalCents,
    treasuryTotalCents,
    systemTotalCents: customerTotalCents + treasuryTotalCents,
  }
}

const summarizeTreasuryAccount = async ({
  accountId,
  accountsRepo,
  walletsRepo,
  getBalanceForWallet,
  balanceReadAttempts,
  balanceMode,
}: {
  accountId: AccountId
  accountsRepo: BuildSnapshotArgs["accountsRepo"]
  walletsRepo: BuildSnapshotArgs["walletsRepo"]
  getBalanceForWallet: BuildSnapshotArgs["getBalanceForWallet"]
  balanceReadAttempts: number
  balanceMode: BuildSnapshotArgs["balanceMode"]
}): Promise<OperatorTreasuryAccount> => {
  const account = await accountsRepo.findById(accountId)
  if (account instanceof Error) {
    return {
      accountId,
      walletCount: 0,
      usdWallets: [],
      usdtWallets: [],
      anomalies: ["missing_account"],
    }
  }

  const rawWallets = await walletsRepo.listByAccountId(account.id)
  if (rawWallets instanceof Error) throw rawWallets

  const cashWallets = rawWallets.filter((wallet) => wallet.type === WalletType.Checking)
  const usdWalletsRaw = cashWallets.filter(
    (wallet) => wallet.currency === WalletCurrency.Usd,
  )
  const usdtWalletsRaw = cashWallets.filter(
    (wallet) => wallet.currency === WalletCurrency.Usdt,
  )
  const defaultWallet = cashWallets.find((wallet) => wallet.id === account.defaultWalletId)

  const [usdWallets, usdtWallets] = await Promise.all([
    Promise.all(
      usdWalletsRaw.map((wallet) =>
        summarizeWallet({
          wallet,
          getBalanceForWallet,
          balanceReadAttempts,
          balanceMode,
        }),
      ),
    ),
    Promise.all(
      usdtWalletsRaw.map((wallet) =>
        summarizeWallet({
          wallet,
          getBalanceForWallet,
          balanceReadAttempts,
          balanceMode,
        }),
      ),
    ),
  ])

  return {
    accountId: account.id,
    accountUuid: account.uuid,
    role: account.role ?? "funder",
    defaultWalletId: account.defaultWalletId,
    defaultWalletCurrency: defaultWallet?.currency,
    walletCount: rawWallets.length,
    usdWallets,
    usdtWallets,
    anomalies: [...usdWallets, ...usdtWallets].some(
      (wallet) => wallet.balance.error !== undefined,
    )
      ? ["balance_error"]
      : [],
  }
}

export const buildCashWalletCutoverOperatorSnapshot = async ({
  manifestAccounts,
  discoveredAccounts,
  accountsRepo,
  walletsRepo,
  migrationsRepo,
  getBalanceForWallet,
  migrationLookup,
  preflightReport,
  balanceReadAttempts = 1,
  balanceMode = "live",
  treasuryAccountIds = [],
  now = new Date(),
}: BuildSnapshotArgs): Promise<CashWalletCutoverOperatorSnapshot> => {
  const config = await migrationsRepo.getConfig()
  if (config instanceof Error) throw config
  const lookup =
    migrationLookup ??
    (config.runId
      ? {
          cutoverVersion: config.cutoverVersion,
          runId: config.runId,
        }
      : undefined)

  const accounts: OperatorAccount[] = []
  const migrationStatuses: Record<string, number> = {}
  const operatorAccounts = accountsForDashboard({ manifestAccounts, discoveredAccounts })

  for (const dashboardAccount of operatorAccounts) {
    const anomalies: string[] = []
    const account = await accountsRepo.findById(dashboardAccount.accountId)
    if (account instanceof Error) {
      increment(migrationStatuses, "none")
      accounts.push({
        ...dashboardAccount,
        walletCount: 0,
        usdWallets: [],
        usdtWallets: [],
        migrationStatus: "none",
        anomalies: ["missing_account"],
      })
      continue
    }

    const rawWallets = await walletsRepo.listByAccountId(account.id)
    if (rawWallets instanceof Error) throw rawWallets

    const cashWallets = rawWallets.filter((wallet) => wallet.type === WalletType.Checking)
    const usdWalletsRaw = cashWallets.filter(
      (wallet) => wallet.currency === WalletCurrency.Usd,
    )
    const usdtWalletsRaw = cashWallets.filter(
      (wallet) => wallet.currency === WalletCurrency.Usdt,
    )
    const defaultWallet = cashWallets.find(
      (wallet) => wallet.id === account.defaultWalletId,
    )

    if (usdWalletsRaw.length === 0) anomalies.push("missing_usd")
    if (usdtWalletsRaw.length === 0) anomalies.push("missing_usdt")
    if (usdWalletsRaw.length > 1) anomalies.push("duplicate_usd")
    if (usdtWalletsRaw.length > 1) anomalies.push("duplicate_usdt")
    if (!defaultWallet) anomalies.push("default_not_cash")

    const [usdWallets, usdtWallets] = await Promise.all([
      Promise.all(
        usdWalletsRaw.map((wallet) =>
          summarizeWallet({
            wallet,
            expectedWalletId: dashboardAccount.expectedUsdWalletId,
            getBalanceForWallet,
            balanceReadAttempts,
            balanceMode,
          }),
        ),
      ),
      Promise.all(
        usdtWalletsRaw.map((wallet) =>
          summarizeWallet({
            wallet,
            expectedWalletId: dashboardAccount.expectedUsdtWalletId,
            getBalanceForWallet,
            balanceReadAttempts,
            balanceMode,
          }),
        ),
      ),
    ])

    if (
      [...usdWallets, ...usdtWallets].some((wallet) => wallet.balance.error !== undefined)
    ) {
      anomalies.push("balance_error")
    }
    if ([...usdWallets, ...usdtWallets].some((wallet) => !wallet.expected)) {
      anomalies.push("unexpected_wallet_id")
    }

    let migrationStatus: CashWalletMigrationStatus | "none" = "none"
    let migrationUpdatedAt: string | undefined
    let migration: CashWalletMigration | null = null
    if (lookup) {
      const migrationResult = await migrationsRepo.findMigrationByAccountId({
        accountId: account.id,
        cutoverVersion: lookup.cutoverVersion,
        runId: lookup.runId,
      })
      if (migrationResult instanceof Error) throw migrationResult
      migration = migrationResult
      if (migration) {
        migrationStatus = migration.status
        migrationUpdatedAt = migration.updatedAt?.toISOString()
        if (migration.status === "failed") anomalies.push("migration_failed")
        if (migration.status === "requires_operator_review") {
          anomalies.push("migration_requires_review")
        }
      }
    }
    increment(migrationStatuses, migrationStatus)

    accounts.push({
      ...dashboardAccount,
      accountUuid: account.uuid ?? dashboardAccount.accountUuid,
      defaultWalletId: account.defaultWalletId,
      defaultWalletCurrency: defaultWallet?.currency,
      walletCount: rawWallets.length,
      usdWallets,
      usdtWallets,
      migrationStatus,
      migrationUpdatedAt,
      cutoverBalanceAudit: computeCutoverBalanceAudit({ migration, usdtWallets }),
      anomalies,
    })
  }

  const treasuryAccounts = await Promise.all(
    treasuryAccountIds.map((accountId) =>
      summarizeTreasuryAccount({
        accountId,
        accountsRepo,
        walletsRepo,
        getBalanceForWallet,
        balanceReadAttempts,
        balanceMode,
      }),
    ),
  )
  const treasury = treasurySummary(treasuryAccounts)
  const usdTotalCents = usdTotalCentsForAccounts(accounts)
  const usdtTotalMicros = usdtTotalMicrosForAccounts(accounts)
  const missingUsdt = accounts.filter(
    (account) => account.usdtWallets.length === 0,
  ).length
  const blockers = accounts.filter(
    (account) =>
      account.anomalies.includes("missing_usd") ||
      account.anomalies.includes("missing_usdt"),
  ).length

  const reconciliation = reconciliationSummary({
    customerUsdTotalCents: usdTotalCents,
    customerUsdtTotalMicros: usdtTotalMicros,
    treasury,
  })

  return {
    generatedAt: now.toISOString(),
    cutover: {
      state: config.state,
      cutoverVersion: config.cutoverVersion,
      runId: config.runId,
      updatedAt: config.updatedAt?.toISOString(),
    },
    preflight: preflightReport,
    summary: {
      accounts: accounts.length,
      wallets: {
        current: accounts.reduce((sum, account) => sum + account.walletCount, 0),
        target: accounts.length * 2,
        usd: accounts.reduce((sum, account) => sum + account.usdWallets.length, 0),
        usdt: accounts.reduce((sum, account) => sum + account.usdtWallets.length, 0),
        missingUsdt,
      },
      fundedUsdOnlyAccounts: accounts.filter(
        (account) =>
          account.usdtWallets.length === 0 &&
          account.usdWallets.some((wallet) => wallet.balance.minorUnitsNumber > 0),
      ).length,
      usdTotalCents,
      usdtTotalMicros,
      anomalies: accounts.filter((account) => account.anomalies.length > 0).length,
      watchlistAnomalies: accounts.filter(
        (account) => account.watchlisted && account.anomalies.length > 0,
      ).length,
      canStart: blockers === 0,
      blockers,
      watchlistAccounts: accounts.filter((account) => account.watchlisted).length,
      migrationStatuses,
    },
    accounts,
    treasury: {
      accounts: treasuryAccounts,
      summary: treasury,
    },
    reconciliation,
  }
}
