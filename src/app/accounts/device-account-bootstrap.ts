import { createHash } from "crypto"

import { DeviceBootstrapError } from "@domain/authentication/device-bootstrap-error"
import type {
  BootstrapAccount,
  BootstrapCurrency,
  BootstrapSlot,
  BootstrapWallet,
  DeviceBootstrapDependencies,
  DeviceBootstrapJournalRecord,
} from "@domain/accounts/device-bootstrap"

const currencies: BootstrapCurrency[] = ["USD", "USDT"]
const failure = (code: ConstructorParameters<typeof DeviceBootstrapError>[0]) =>
  new DeviceBootstrapError(code)
const support = () => failure("DEVICE_BOOTSTRAP_SUPPORT_REQUIRED")
const retry = () => failure("DEVICE_BOOTSTRAP_RETRY_REQUIRED")
const ownerMismatch = () => failure("DEVICE_BOOTSTRAP_OWNER_MISMATCH")
const providerId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[^A-Za-z0-9_-]/.test(value)

export type DeviceBootstrapInput = {
  userId: string
  deviceId: string
  isCancelled?: () => boolean
}

/** Authenticated device owner only. No credential, token, amount or provider balance enters this engine. */
export const resumeDeviceAccountBootstrap = async (
  input: DeviceBootstrapInput,
  supplied?: DeviceBootstrapDependencies,
): Promise<true | DeviceBootstrapError> => {
  try {
    if (
      !input.userId ||
      input.userId.length > 128 ||
      /[^A-Za-z0-9_-]/.test(input.userId) ||
      input.deviceId.length !== 36 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.deviceId,
      )
    )
      throw ownerMismatch()
    const key = createHash("sha256").update(input.deviceId).digest("hex")
    let controlledIdentity = false
    const deps =
      supplied ??
      (await import("./device-bootstrap-adapters")).deviceBootstrapDependencies()
    const store = deps.store
    let lockAborted = () => false
    const check = () => {
      if (input.isCancelled?.() || lockAborted()) throw retry()
    }
    const verifyIdentity = async () => {
      check()
      const identity = await deps.identity(input.userId)
      check()
      if (identity.id !== input.userId || identity.username !== input.deviceId)
        throw ownerMismatch()
      if (
        identity.schema !== "username_password_deviceid_v0" ||
        identity.state !== "active" ||
        identity.totpEnabled !== false
      ) {
        throw failure("DEVICE_BOOTSTRAP_INCOMPATIBLE_IDENTITY")
      }
      if (
        identity.bootstrap !== undefined &&
        (identity.bootstrap.version !== 1 || identity.bootstrap.deviceIdHash !== key)
      ) {
        throw failure("DEVICE_BOOTSTRAP_INCOMPATIBLE_IDENTITY")
      }
      controlledIdentity = identity.bootstrap !== undefined
      const bindings = await store.userBindings(input.userId, input.deviceId)
      check()
      if (
        bindings.length > 1 ||
        bindings.some(
          (binding) =>
            binding.userId !== input.userId ||
            (binding.deviceId !== undefined && binding.deviceId !== input.deviceId) ||
            binding.hasPhone,
        )
      )
        throw ownerMismatch()
    }
    const readAccount = async (expected?: string): Promise<BootstrapAccount | null> => {
      const accounts = await store.accounts(input.userId)
      check()
      if (
        accounts.length > 1 ||
        accounts.some(
          (account) =>
            account.userId !== input.userId ||
            (expected !== undefined && account.id !== expected),
        )
      )
        throw ownerMismatch()
      return accounts[0] ?? null
    }
    const owned = (
      wallets: BootstrapWallet[],
      account: BootstrapAccount,
      currency: BootstrapCurrency,
    ) =>
      wallets.filter(
        (wallet) =>
          wallet.accountId === account.id &&
          wallet.type === "checking" &&
          wallet.currency === currency,
      )
    const inspect = async (account: BootstrapAccount) => {
      const wallets = await store.wallets(account.id)
      check()
      if (
        wallets.some((wallet) => wallet.accountId !== account.id) ||
        new Set(wallets.map((wallet) => wallet.id)).size !== wallets.length
      )
        throw ownerMismatch()
      if (currencies.some((currency) => owned(wallets, account, currency).length > 1))
        throw support()
      return wallets
    }
    const ready = (account: BootstrapAccount, wallets: BootstrapWallet[]) =>
      account.status === "active" &&
      currencies.every((currency) => owned(wallets, account, currency).length === 1) &&
      account.defaultWalletId !== undefined &&
      wallets.some((wallet) => wallet.id === account.defaultWalletId)
    const compatibleRecord = (record: DeviceBootstrapJournalRecord, key: string) => {
      if (record._id !== key || record.userId !== input.userId || record.version !== 1)
        throw ownerMismatch()
      if (
        currencies.some((currency) =>
          ["dispatching", "blocked"].includes(record.wallets[currency].state),
        )
      )
        throw support()
    }

    await verifyIdentity()
    let record = await store.journal(key)
    check()
    if (!record) {
      const account = await readAccount()
      let mode: DeviceBootstrapJournalRecord["mode"] = "new"
      if (account) {
        const wallets = await inspect(account)
        // A legacy local default can be repaired only when all required wallets
        // already exist, and the missing preferred USDT choice is unambiguous.
        const localOnly =
          account.status === "active" &&
          (account.level ?? 0) === 0 &&
          account.defaultWalletId === undefined &&
          currencies.every(
            (currency) => owned(wallets, account, currency).length === 1,
          ) &&
          owned(wallets, account, "USDT").length === 1
        if (!ready(account, wallets) && !localOnly) throw support()
        mode = "legacy-local"
      } else if (!controlledIdentity) {
        // No journal means no proof an old attempt never reached a provider.
        throw support()
      }
      const now = new Date()
      record = await store.reserve({
        _id: key,
        version: 1,
        userId: input.userId,
        accountId: account?.id ?? deps.newAccountId(),
        mode,
        phase: "initializing",
        wallets: { USD: { state: "planned" }, USDT: { state: "planned" } },
        createdAt: now,
        updatedAt: now,
      })
      check()
    }
    compatibleRecord(record, key)
    const reserved = record
    return await deps.withAccountLock(
      record.accountId,
      async (aborted): Promise<true> => {
        lockAborted = aborted
        await verifyIdentity()
        record = await store.journal(key)
        check()
        if (
          !record ||
          record.accountId !== reserved.accountId ||
          record.mode !== reserved.mode
        )
          throw ownerMismatch()
        compatibleRecord(record, key)
        let account = await readAccount(record.accountId)
        if (record.phase === "ready") {
          await verifyIdentity()
          account = await readAccount(record.accountId)
          if (!account || !ready(account, await inspect(account))) throw support()
          check()
          return true
        }
        if (!account) {
          if (record.mode !== "new") throw support()
          account = await store.ensureAccount(record)
          check()
          if (account.id !== record.accountId || account.userId !== input.userId)
            throw ownerMismatch()
        }
        let wallets = await inspect(account)
        if (record.mode === "new" && (account.level ?? 0) !== 0) {
          // An upgrade may retain an otherwise complete account. Never initialize
          // or attach resources to a partially upgraded account on the trial path.
          if (!ready(account, wallets)) throw support()
        }
        if (account.status !== "active") throw support()
        if (record.mode === "new" && (account.level ?? 0) === 0) {
          await store.bindDeviceMetadata(input.userId, input.deviceId)
          await verifyIdentity()
        }
        for (const currency of currencies) {
          let slot: BootstrapSlot = record.wallets[currency]
          if (slot.state === "attached") {
            if (
              !owned(wallets, account, currency).some(
                (wallet) => wallet.id === slot.providerId,
              )
            )
              throw support()
            continue
          }
          if (slot.state === "planned") {
            const existing = owned(wallets, account, currency)
            if (existing.length > 0) {
              const preferred = existing[0] // inspect() proves exactly one owned Checking wallet.
              record = await store.transition(record, currency, slot, {
                state: "attached",
                providerId: preferred.id,
                origin: "local",
              })
              check()
              continue
            }
            if (record.mode !== "new" || (account.level ?? 0) !== 0) throw support()
            await verifyIdentity()
            const current = await readAccount(account.id)
            if (!current || (current.level ?? 0) !== 0 || current.status !== "active")
              throw support()
            wallets = await inspect(current)
            const appeared = owned(wallets, current, currency)
            if (appeared.length === 1) {
              record = await store.transition(record, currency, slot, {
                state: "attached",
                providerId: appeared[0].id,
                origin: "local",
              })
              check()
              continue
            }
            const intent: BootstrapSlot = {
              state: "dispatching",
              attemptId: deps.newAttemptId(),
            }
            record = await store.transition(record, currency, slot, intent)
            // A known cancellation before invocation is the only safe rollback of
            // dispatch intent. A crash in this gap still remains support-required.
            if (input.isCancelled?.() || lockAborted()) {
              await store.transition(record, currency, intent, { state: "planned" })
              throw retry()
            }
            let response: Awaited<
              ReturnType<DeviceBootstrapDependencies["createProviderAccount"]>
            >
            try {
              response = await deps.createProviderAccount(account.id, currency)
            } catch {
              throw support()
            }
            const id = providerId(response?.id) ? response.id : undefined
            if (
              !id ||
              response?.name !== account.id ||
              response?.currencyId !== deps.currencyId(currency)
            ) {
              try {
                await store.transition(record, currency, intent, {
                  state: "blocked",
                  attemptId: intent.attemptId,
                  providerId: id,
                })
              } catch {
                /* Intent remains unresolved. */
              }
              throw support()
            }
            // Persist the validated resource ID even if the caller/identity changed
            // while provider creation was in flight. Never lose a known receipt.
            const known: BootstrapSlot = {
              state: "known",
              attemptId: intent.attemptId,
              providerId: id,
              origin: "created",
            }
            try {
              record = await store.transition(record, currency, intent, known)
            } catch {
              throw support()
            }
            slot = known
          }
          if (slot.state !== "known" || !slot.providerId || slot.origin !== "created")
            throw support()
          await verifyIdentity()
          const current = await readAccount(account.id)
          if (!current || (current.level ?? 0) !== 0 || current.status !== "active")
            throw support()
          const beforeAttach = owned(await inspect(current), current, currency)
          if (beforeAttach.length === 1 && beforeAttach[0].id !== slot.providerId)
            throw support()
          await store.attach(record, currency, slot.providerId)
          check()
          record = await store.transition(record, currency, slot, {
            ...slot,
            state: "attached",
          })
          check()
          wallets = await inspect(account)
        }
        account = await readAccount(record.accountId)
        if (!account) throw ownerMismatch()
        wallets = await inspect(account)
        if (account.defaultWalletId === undefined) {
          const preferred = owned(wallets, account, "USDT")
          if ((account.level ?? 0) !== 0 || preferred.length !== 1) throw support()
          await verifyIdentity()
          const latest = await readAccount(record.accountId)
          if (!latest) throw ownerMismatch()
          const latestPreferred = owned(await inspect(latest), latest, "USDT")
          if (latest.defaultWalletId === undefined) {
            if (
              (latest.level ?? 0) !== 0 ||
              latest.status !== "active" ||
              latestPreferred.length !== 1
            )
              throw support()
            await store.setMissingDefault(record, latestPreferred[0].id)
            check()
          }
        }
        account = await readAccount(record.accountId)
        if (!account || !ready(account, await inspect(account))) throw support()
        await verifyIdentity()
        record = await store.ready(record)
        check()
        // Only authoritative local owned readiness, never a provider acceptance
        // guess or merely a newly minted Kratos bearer, permits the REST token.
        await verifyIdentity()
        account = await readAccount(record.accountId)
        if (!account || !ready(account, await inspect(account))) throw support()
        check()
        return true
      },
    )
  } catch (error) {
    return error instanceof DeviceBootstrapError ? error : retry()
  }
}
