export type BootstrapCurrency = "USD" | "USDT"
export type BootstrapSlot = {
  state: "planned" | "dispatching" | "known" | "attached" | "blocked"
  attemptId?: string
  providerId?: string
  origin?: "created" | "local"
}
export type DeviceBootstrapJournalRecord = {
  _id: string
  version: 1
  userId: string
  accountId: string
  mode: "new" | "legacy-local"
  phase: "initializing" | "ready"
  wallets: { USD: BootstrapSlot; USDT: BootstrapSlot }
  createdAt: Date
  updatedAt: Date
}
export type BootstrapAccount = {
  id: string
  userId: string
  level?: number
  status: string
  defaultWalletId?: string
}
export type BootstrapWallet = {
  id: string
  accountId: string
  currency: string
  type: string
}
export type BootstrapUserBinding = {
  userId: string
  deviceId?: string
  hasPhone: boolean
}
export type DeviceIdentityProof = {
  id: string
  schema: string
  state: string
  username?: string
  totpEnabled: boolean
  bootstrap?: { version: unknown; deviceIdHash: unknown }
}

/** All mutating predicates bind immutable journal owner/account identity. */
export interface DeviceBootstrapStore {
  journal(key: string): Promise<DeviceBootstrapJournalRecord | null>
  reserve(record: DeviceBootstrapJournalRecord): Promise<DeviceBootstrapJournalRecord>
  accounts(userId: string): Promise<BootstrapAccount[]>
  userBindings(userId: string, deviceId: string): Promise<BootstrapUserBinding[]>
  bindDeviceMetadata(userId: string, deviceId: string): Promise<void>
  ensureAccount(record: DeviceBootstrapJournalRecord): Promise<BootstrapAccount>
  wallets(accountId: string): Promise<BootstrapWallet[]>
  attach(
    record: DeviceBootstrapJournalRecord,
    currency: BootstrapCurrency,
    providerId: string,
  ): Promise<void>
  transition(
    record: DeviceBootstrapJournalRecord,
    currency: BootstrapCurrency,
    from: BootstrapSlot,
    to: BootstrapSlot,
  ): Promise<DeviceBootstrapJournalRecord>
  setMissingDefault(record: DeviceBootstrapJournalRecord, walletId: string): Promise<void>
  ready(record: DeviceBootstrapJournalRecord): Promise<DeviceBootstrapJournalRecord>
}
export type DeviceBootstrapDependencies = {
  store: DeviceBootstrapStore
  identity(userId: string): Promise<DeviceIdentityProof>
  createProviderAccount(
    accountId: string,
    currency: BootstrapCurrency,
  ): Promise<{ id?: string; name?: string; currencyId?: number }>
  currencyId(currency: BootstrapCurrency): number
  newAccountId(): string
  newAttemptId(): string
  withAccountLock<T>(
    accountId: string,
    work: (aborted: () => boolean) => Promise<T>,
  ): Promise<T>
}
