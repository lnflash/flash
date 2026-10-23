import { createHash } from "crypto"

import { resumeDeviceAccountBootstrap } from "@app/accounts/device-account-bootstrap"
import type {
  BootstrapAccount,
  BootstrapCurrency,
  BootstrapSlot,
  BootstrapWallet,
  DeviceBootstrapDependencies,
  DeviceBootstrapJournalRecord,
  DeviceBootstrapStore,
  DeviceIdentityProof,
} from "@domain/accounts/device-bootstrap"
import {
  DeviceBootstrapError,
  DeviceBootstrapCode,
} from "@domain/authentication/device-bootstrap-error"

const USER = "kratos-owner"
const DEVICE = "11111111-1111-4111-8111-111111111111"
const ACCOUNT = "000000000000000000000001"
const KEY = createHash("sha256").update(DEVICE).digest("hex")
const copy = <T>(value: T): T => structuredClone(value)
const error = (code: DeviceBootstrapCode) => new DeviceBootstrapError(code)

class MemoryStore implements DeviceBootstrapStore {
  saved: DeviceBootstrapJournalRecord | null = null
  accountRows: BootstrapAccount[] = []
  walletRows: BootstrapWallet[] = []
  bindings: { userId: string; deviceId?: string; hasPhone: boolean }[] = []
  events: string[] = []
  faults = new Map<string, "before" | "after">()
  afterAction?: (name: string) => void
  async action<T>(name: string, work: () => T): Promise<T> {
    this.events.push(name)
    const mode = this.faults.get(name)
    this.faults.delete(name)
    if (mode === "before") throw error("DEVICE_BOOTSTRAP_RETRY_REQUIRED")
    const value = work()
    this.afterAction?.(name)
    if (mode === "after") throw error("DEVICE_BOOTSTRAP_RETRY_REQUIRED")
    return copy(value)
  }
  async journal() {
    return this.action("journal", () => this.saved)
  }
  async reserve(record: DeviceBootstrapJournalRecord) {
    return this.action("reserve", () => {
      if (this.saved && this.saved.userId !== record.userId)
        throw error("DEVICE_BOOTSTRAP_OWNER_MISMATCH")
      this.saved ??= copy(record)
      return this.saved
    })
  }
  async accounts() {
    return this.action("accounts", () => this.accountRows)
  }
  async userBindings() {
    return this.action("userBindings", () => this.bindings)
  }
  async bindDeviceMetadata(userId: string, deviceId: string) {
    await this.action("bindDeviceMetadata", () => {
      if (!this.bindings.length) this.bindings.push({ userId, deviceId, hasPhone: false })
      else this.bindings[0].deviceId = deviceId
    })
  }
  async ensureAccount(record: DeviceBootstrapJournalRecord) {
    return this.action("ensureAccount", () => {
      if (!this.accountRows.length)
        this.accountRows.push({
          id: record.accountId,
          userId: record.userId,
          level: 0,
          status: "active",
        })
      return this.accountRows[0]
    })
  }
  async wallets(accountId: string) {
    return this.action("wallets", () =>
      this.walletRows.filter((wallet) => wallet.accountId === accountId),
    )
  }
  async attach(
    record: DeviceBootstrapJournalRecord,
    currency: BootstrapCurrency,
    providerId: string,
  ) {
    await this.action(`attach:${currency}`, () => {
      const existing = this.walletRows.find((wallet) => wallet.id === providerId)
      if (
        existing &&
        (existing.accountId !== record.accountId || existing.currency !== currency)
      )
        throw error("DEVICE_BOOTSTRAP_OWNER_MISMATCH")
      if (!existing)
        this.walletRows.push({
          id: providerId,
          accountId: record.accountId,
          currency,
          type: "checking",
        })
    })
  }
  async transition(
    record: DeviceBootstrapJournalRecord,
    currency: BootstrapCurrency,
    from: BootstrapSlot,
    to: BootstrapSlot,
  ) {
    return this.action(`transition:${currency}:${to.state}`, () => {
      if (
        !this.saved ||
        this.saved.userId !== record.userId ||
        this.saved.accountId !== record.accountId
      )
        throw error("DEVICE_BOOTSTRAP_OWNER_MISMATCH")
      const current = this.saved.wallets[currency]
      if (
        current.state !== from.state ||
        current.attemptId !== from.attemptId ||
        current.providerId !== from.providerId
      )
        throw error("DEVICE_BOOTSTRAP_RETRY_REQUIRED")
      this.saved.wallets[currency] = copy(to)
      return this.saved
    })
  }
  async setMissingDefault(record: DeviceBootstrapJournalRecord, walletId: string) {
    await this.action("setMissingDefault", () => {
      const account = this.accountRows.find(
        (account) => account.id === record.accountId && account.userId === record.userId,
      )
      if (account && account.defaultWalletId === undefined && (account.level ?? 0) === 0)
        account.defaultWalletId = walletId
    })
  }
  async ready(record: DeviceBootstrapJournalRecord) {
    return this.action("ready", () => {
      if (
        !this.saved ||
        this.saved._id !== record._id ||
        this.saved.wallets.USD.state !== "attached" ||
        this.saved.wallets.USDT.state !== "attached"
      )
        throw error("DEVICE_BOOTSTRAP_RETRY_REQUIRED")
      this.saved.phase = "ready"
      return this.saved
    })
  }
}
const fixture = () => {
  const store = new MemoryStore()
  const identity: DeviceIdentityProof = {
    id: USER,
    schema: "username_password_deviceid_v0",
    state: "active",
    username: DEVICE,
    totpEnabled: false,
    bootstrap: { version: 1, deviceIdHash: KEY },
  }
  const providerCalls: BootstrapCurrency[] = []
  const providerResources: string[] = []
  const queues = new Map<string, Promise<unknown>>()
  let sequence = 0,
    accountSequence = 0,
    cancelled = false
  const hooks: {
    provider?: (currency: BootstrapCurrency) => Promise<void>
    identity?: () => void
  } = {}
  const deps: DeviceBootstrapDependencies = {
    store,
    identity: async () => {
      hooks.identity?.()
      return copy(identity)
    },
    newAccountId: () => (++accountSequence).toString(16).padStart(24, "0"),
    newAttemptId: () => `attempt-${++sequence}`,
    currencyId: (currency) => (currency === "USD" ? 1 : 2),
    createProviderAccount: async (accountId, currency) => {
      providerCalls.push(currency)
      expect(store.saved?.wallets[currency].state).toBe("dispatching")
      const id = `provider-${currency}-${providerCalls.filter((call) => call === currency).length}`
      providerResources.push(id)
      await hooks.provider?.(currency)
      return { id, name: accountId, currencyId: currency === "USD" ? 1 : 2 }
    },
    withAccountLock: async (accountId, work) => {
      const next = (queues.get(accountId) ?? Promise.resolve()).then(() =>
        work(() => false),
      )
      queues.set(
        accountId,
        next.catch(() => undefined),
      )
      return next
    },
  }
  const run = () =>
    resumeDeviceAccountBootstrap(
      { userId: USER, deviceId: DEVICE, isCancelled: () => cancelled },
      deps,
    )
  return {
    store,
    identity,
    providerCalls,
    providerResources,
    deps,
    hooks,
    run,
    cancel: () => {
      cancelled = true
    },
    resume: () => {
      cancelled = false
    },
  }
}
const expectCode = (value: unknown, code: DeviceBootstrapCode) => {
  expect(value).toBeInstanceOf(DeviceBootstrapError)
  expect((value as DeviceBootstrapError).code).toBe(code)
}
const existing = (
  store: MemoryStore,
  options: { default?: string; level?: number; status?: string; both?: boolean } = {},
) => {
  store.accountRows = [
    {
      id: ACCOUNT,
      userId: USER,
      level: options.level ?? 0,
      status: options.status ?? "active",
      defaultWalletId: options.default,
    },
  ]
  store.walletRows = [
    { id: "legacy-usd", accountId: ACCOUNT, type: "checking", currency: "USD" },
  ]
  if (options.both !== false)
    store.walletRows.push({
      id: "legacy-usdt",
      accountId: ACCOUNT,
      type: "checking",
      currency: "USDT",
    })
}

it("journals provider intent and known IDs before attachment and returns ready only after both owned cash wallets/default", async () => {
  const f = fixture()
  expect(await f.run()).toBe(true)
  expect(f.providerCalls).toEqual(["USD", "USDT"])
  expect(f.store.saved?.phase).toBe("ready")
  expect(f.store.saved?.wallets.USD.providerId).toBe("provider-USD-1")
  expect(f.store.events.indexOf("transition:USD:known")).toBeLessThan(
    f.store.events.indexOf("attach:USD"),
  )
  expect(f.store.accountRows[0].defaultWalletId).toBe("provider-USDT-1")
  expect(f.store.walletRows).toHaveLength(2)
  const before = f.providerCalls.length
  expect(await f.run()).toBe(true)
  expect(f.providerCalls.length).toBe(before)
  expect(f.store.walletRows).toHaveLength(2)
})

it.each(["reserve", "ensureAccount", "bindDeviceMetadata", "transition:USD:dispatching"])(
  "resumes after a pre-provider %s storage failure without duplicating resources",
  async (operation) => {
    const f = fixture()
    f.store.faults.set(operation, "before")
    expectCode(await f.run(), "DEVICE_BOOTSTRAP_RETRY_REQUIRED")
    expect(f.providerCalls).toHaveLength(0)
    expect(await f.run()).toBe(true) // Admin-only provenance survives missing first Mongo write.
    expect(f.providerCalls).toEqual(["USD", "USDT"])
  },
)

it("does not infer no provider acceptance from a lost dispatch-intent storage acknowledgment", async () => {
  const f = fixture()
  f.store.faults.set("transition:USD:dispatching", "after")
  expectCode(await f.run(), "DEVICE_BOOTSTRAP_RETRY_REQUIRED")
  expect(f.providerCalls).toHaveLength(0)
  for (let attempt = 0; attempt < 3; attempt++)
    expectCode(await f.run(), "DEVICE_BOOTSTRAP_SUPPORT_REQUIRED")
  expect(f.providerCalls).toHaveLength(0)
})

it.each(["USD", "USDT"] as BootstrapCurrency[])(
  "never recreates a provider resource after unknown %s acceptance",
  async (currency) => {
    const f = fixture()
    f.hooks.provider = async (actual) => {
      if (actual === currency) throw new Error("PRIVATE_PROVIDER_REPLY")
    }
    expectCode(await f.run(), "DEVICE_BOOTSTRAP_SUPPORT_REQUIRED")
    const calls = [...f.providerCalls]
    f.hooks.provider = undefined
    for (let attempt = 0; attempt < 3; attempt++)
      expectCode(await f.run(), "DEVICE_BOOTSTRAP_SUPPORT_REQUIRED")
    expect(f.providerCalls).toEqual(calls)
    expect(f.store.saved?.wallets[currency].state).toBe("dispatching")
  },
)

it.each(["before", "after"] as const)(
  "handles a %s-failure when persisting a known ID conservatively",
  async (mode) => {
    const f = fixture()
    f.store.faults.set("transition:USD:known", mode)
    expectCode(await f.run(), "DEVICE_BOOTSTRAP_SUPPORT_REQUIRED")
    const result = await f.run()
    expect(result === true ? true : result.code).toBe(
      mode === "before" ? "DEVICE_BOOTSTRAP_SUPPORT_REQUIRED" : true,
    )
    expect(f.providerCalls).toEqual(mode === "before" ? ["USD"] : ["USD", "USDT"])
  },
)

it.each([
  "attach:USD",
  "transition:USD:attached",
  "attach:USDT",
  "setMissingDefault",
  "ready",
])(
  "resumes known local partial %s without another provider account",
  async (operation) => {
    const f = fixture()
    f.store.faults.set(operation, "after")
    expectCode(await f.run(), "DEVICE_BOOTSTRAP_RETRY_REQUIRED")
    expect(await f.run()).toBe(true)
    expect(f.providerCalls).toEqual(["USD", "USDT"])
    expect(new Set(f.store.walletRows.map((wallet) => wallet.id)).size).toBe(2)
  },
)

it("serializes concurrent same-owner initialization and reuses the winning journal/account", async () => {
  const f = fixture()
  expect(await Promise.all([f.run(), f.run(), f.run()])).toEqual([true, true, true])
  expect(f.providerCalls).toEqual(["USD", "USDT"])
  expect(f.store.accountRows).toHaveLength(1)
  expect(f.store.walletRows).toHaveLength(2)
})

it("preserves legacy owned wallets, valid user-selected default, level and settings without provisioning", async () => {
  const f = fixture()
  f.identity.bootstrap = undefined
  existing(f.store, { default: "legacy-usd", level: 3 })
  const before = copy(f.store.accountRows)
  expect(await f.run()).toBe(true)
  expect(f.providerCalls).toHaveLength(0)
  expect(f.store.accountRows).toEqual(before)
  expect(f.store.events).not.toContain("bindDeviceMetadata")
  expect(f.store.events).not.toContain("ensureAccount")
})

it("repairs only a missing unambiguous owned legacy default and never calls a provider", async () => {
  const f = fixture()
  f.identity.bootstrap = undefined
  existing(f.store)
  expect(await f.run()).toBe(true)
  expect(f.store.accountRows[0].defaultWalletId).toBe("legacy-usdt")
  expect(f.providerCalls).toHaveLength(0)
})

it.each([
  "missing-account",
  "missing-wallet",
  "upgraded-missing-default",
  "locked",
  "foreign-default",
  "ambiguous-default",
])("blocks untracked legacy %s rather than guessing provider recovery", async (mode) => {
  const f = fixture()
  f.identity.bootstrap = undefined
  if (mode !== "missing-account")
    existing(f.store, {
      both: mode !== "missing-wallet",
      level: mode === "upgraded-missing-default" ? 1 : 0,
      status: mode === "locked" ? "locked" : "active",
      default: mode === "foreign-default" ? "someone-elses-wallet" : undefined,
    })
  if (mode === "ambiguous-default")
    f.store.walletRows.push({
      id: "second-usdt",
      accountId: ACCOUNT,
      type: "checking",
      currency: "USDT",
    })
  const before = copy(f.store.accountRows)
  expectCode(await f.run(), "DEVICE_BOOTSTRAP_SUPPORT_REQUIRED")
  expect(f.providerCalls).toHaveLength(0)
  expect(f.store.accountRows).toEqual(before)
})

it.each([
  "foreign-id",
  "foreign-username",
  "phone-schema",
  "inactive",
  "totp",
  "marker-hash",
  "marker-version",
  "foreign-user-binding",
  "phone-metadata",
])("refuses %s before repairing or provisioning", async (mode) => {
  const f = fixture()
  if (mode === "foreign-id") f.identity.id = "another-owner"
  if (mode === "foreign-username") f.identity.username = "another-device"
  if (mode === "phone-schema") f.identity.schema = "phone_no_password_v0"
  if (mode === "inactive") f.identity.state = "inactive"
  if (mode === "totp") f.identity.totpEnabled = true
  if (mode === "marker-hash") f.identity.bootstrap!.deviceIdHash = "foreign"
  if (mode === "marker-version") f.identity.bootstrap!.version = 2
  if (mode === "foreign-user-binding")
    f.store.bindings = [{ userId: "another-owner", deviceId: DEVICE, hasPhone: false }]
  if (mode === "phone-metadata")
    f.store.bindings = [{ userId: USER, deviceId: DEVICE, hasPhone: true }]
  expect(await f.run()).toBeInstanceOf(DeviceBootstrapError)
  expect(f.providerCalls).toHaveLength(0)
  expect(f.store.events).not.toContain("reserve")
})

it("persists a known provider ID after cancellation and resumes only local attachment", async () => {
  const f = fixture()
  f.hooks.provider = async () => {
    f.cancel()
  }
  expectCode(await f.run(), "DEVICE_BOOTSTRAP_RETRY_REQUIRED")
  expect(f.store.saved?.wallets.USD.state).toBe("known")
  expect(f.store.walletRows).toHaveLength(0)
  f.hooks.provider = undefined
  f.resume()
  expect(await f.run()).toBe(true)
  expect(f.providerCalls).toEqual(["USD", "USDT"])
})

it("does not repair an upgraded identity after a known in-flight provider result", async () => {
  const f = fixture()
  f.hooks.provider = async () => {
    f.identity.schema = "phone_no_password_v0"
    f.store.accountRows[0].level = 1
  }
  expectCode(await f.run(), "DEVICE_BOOTSTRAP_INCOMPATIBLE_IDENTITY")
  expect(f.store.saved?.wallets.USD.state).toBe("known")
  expect(f.store.accountRows[0].level).toBe(1)
  expect(f.store.walletRows).toHaveLength(0)
  expect(f.providerCalls).toEqual(["USD"])
})

it("blocks provider IDs claimed by another local account without changing that owner", async () => {
  const f = fixture()
  f.store.walletRows.push({
    id: "provider-USD-1",
    accountId: "foreign",
    currency: "USD",
    type: "checking",
  })
  expectCode(await f.run(), "DEVICE_BOOTSTRAP_OWNER_MISMATCH")
  expect(f.store.walletRows[0].accountId).toBe("foreign")
  expect(f.providerCalls).toEqual(["USD"])
})

it("does not treat newly visible local wallets as reconciliation for an unknown dispatch", async () => {
  const f = fixture()
  f.hooks.provider = async () => {
    throw new Error("Lost")
  }
  expectCode(await f.run(), "DEVICE_BOOTSTRAP_SUPPORT_REQUIRED")
  f.store.walletRows.push(
    { id: "unrelated-usd", accountId: ACCOUNT, currency: "USD", type: "checking" },
    { id: "unrelated-usdt", accountId: ACCOUNT, currency: "USDT", type: "checking" },
  )
  f.store.accountRows[0].defaultWalletId = "unrelated-usdt"
  expectCode(await f.run(), "DEVICE_BOOTSTRAP_SUPPORT_REQUIRED")
  expect(f.providerCalls).toEqual(["USD"])
})

it("preserves a real owned External default while requiring exactly one Checking wallet of each cash currency", async () => {
  const f = fixture()
  f.identity.bootstrap = undefined
  existing(f.store, { default: "owned-external", level: 2 })
  f.store.walletRows.push({
    id: "owned-external",
    accountId: ACCOUNT,
    type: "external",
    currency: "BTC",
  })
  expect(await f.run()).toBe(true)
  expect(f.providerCalls).toHaveLength(0)
  expect(f.store.accountRows[0].defaultWalletId).toBe("owned-external")
  expect(f.store.accountRows[0].level).toBe(2)
})
it("refuses duplicate owned cash wallets before any provider creation or arbitrary wallet selection", async () => {
  const f = fixture()
  existing(f.store, { default: "legacy-usd" })
  f.store.walletRows.push({
    id: "second-usd",
    accountId: ACCOUNT,
    type: "checking",
    currency: "USD",
  })
  expectCode(await f.run(), "DEVICE_BOOTSTRAP_SUPPORT_REQUIRED")
  expect(f.providerCalls).toHaveLength(0)
  expect(f.store.saved).toBeNull()
  expect(f.store.accountRows[0].defaultWalletId).toBe("legacy-usd")
})

it("stops before provider dispatch when duplicate cash wallets appear during identity revalidation", async () => {
  const f = fixture()
  let reads = 0
  f.hooks.identity = () => {
    if (++reads === 4)
      f.store.walletRows.push(
        { id: "racing-usd-1", accountId: ACCOUNT, currency: "USD", type: "checking" },
        { id: "racing-usd-2", accountId: ACCOUNT, currency: "USD", type: "checking" },
      )
  }
  expectCode(await f.run(), "DEVICE_BOOTSTRAP_SUPPORT_REQUIRED")
  expect(f.providerCalls).toHaveLength(0)
  expect(f.store.events).not.toContain("attach:USD")
})
it("persists an in-flight known ID but refuses attachment when duplicate local cash wallets appeared", async () => {
  const f = fixture()
  f.hooks.provider = async () => {
    f.store.walletRows.push(
      { id: "racing-usd-1", accountId: ACCOUNT, currency: "USD", type: "checking" },
      { id: "racing-usd-2", accountId: ACCOUNT, currency: "USD", type: "checking" },
    )
  }
  expectCode(await f.run(), "DEVICE_BOOTSTRAP_SUPPORT_REQUIRED")
  expect(f.store.saved?.wallets.USD.state).toBe("known")
  expect(f.store.events).not.toContain("attach:USD")
  expect(f.store.accountRows[0].defaultWalletId).toBeUndefined()
})

it("rolls back dispatch intent only for proven cancellation before the provider invocation", async () => {
  const f = fixture()
  f.store.afterAction = (name) => {
    if (name === "transition:USD:dispatching") f.cancel()
  }
  expectCode(await f.run(), "DEVICE_BOOTSTRAP_RETRY_REQUIRED")
  expect(f.providerCalls).toHaveLength(0)
  expect(f.store.saved?.wallets.USD).toEqual({ state: "planned" })
  f.store.afterAction = undefined
  f.resume()
  expect(await f.run()).toBe(true)
  expect(f.providerCalls).toEqual(["USD", "USDT"])
})

it.each([
  { id: "observed-id", name: "foreign-account", currencyId: 1 },
  { id: "observed-id", name: ACCOUNT, currencyId: 2 },
  { id: "../unsafe", name: ACCOUNT, currencyId: 1 },
])(
  "blocks malformed provider receipts without attachment or repeated creation: %j",
  async (receipt) => {
    const f = fixture()
    f.deps.createProviderAccount = jest.fn(async () => receipt)
    expectCode(await f.run(), "DEVICE_BOOTSTRAP_SUPPORT_REQUIRED")
    expect(f.store.saved?.wallets.USD.state).toBe("blocked")
    expect(f.store.walletRows).toHaveLength(0)
    expectCode(await f.run(), "DEVICE_BOOTSTRAP_SUPPORT_REQUIRED")
    expect(f.deps.createProviderAccount).toHaveBeenCalledTimes(1)
    expect(f.store.saved?.wallets.USD.providerId).toBe(
      receipt.id === "../unsafe" ? undefined : "observed-id",
    )
  },
)

it("does not recreate a required wallet removed after journal readiness", async () => {
  const f = fixture()
  expect(await f.run()).toBe(true)
  f.store.walletRows = f.store.walletRows.filter((wallet) => wallet.currency !== "USDT")
  const before = [...f.providerCalls]
  expectCode(await f.run(), "DEVICE_BOOTSTRAP_SUPPORT_REQUIRED")
  expect(f.providerCalls).toEqual(before)
})

it("allows explicit same-credential resume only after authoritative receipt reconciliation", async () => {
  const f = fixture()
  f.hooks.provider = async () => {
    throw new Error("Acceptance unknown")
  }
  expectCode(await f.run(), "DEVICE_BOOTSTRAP_SUPPORT_REQUIRED")
  const intent = f.store.saved!.wallets.USD
  // Simulate an operator independently verifying exact provider ownership/currency
  // and atomically recording its actual receipt. Local wallet appearance alone is insufficient.
  f.store.saved!.wallets.USD = {
    ...intent,
    state: "known",
    providerId: "verified-usd",
    origin: "created",
  }
  f.hooks.provider = undefined
  expect(await f.run()).toBe(true)
  expect(f.providerCalls).toEqual(["USD", "USDT"])
  expect(f.store.walletRows.find((wallet) => wallet.currency === "USD")?.id).toBe(
    "verified-usd",
  )
})
