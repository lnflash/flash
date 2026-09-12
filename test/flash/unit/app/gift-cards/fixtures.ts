// Shared fixtures for the gift-card app-layer specs. Not a spec itself (no
// `.spec.ts` suffix), so jest never tries to run it.

import { RepositoryError } from "@domain/errors"
import { GiftCardOrderNotFoundError, GiftCardOrderStateError } from "@domain/gift-cards"
import { checkGiftCardOrderTransition } from "@services/mongoose/gift-card-orders.mapping"

export const ACCOUNT_ID = "6a8203ce490716aa69381454" as AccountId
export const WALLET_ID = "6a8203ce490716aa69381455" as WalletId
export const NOW_MS = 1_700_000_000_000

const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS

export const makeProduct = (
  overrides: Partial<GiftCardProduct> = {},
): GiftCardProduct => ({
  id: "bitcoinCompany:amazon-us" as GiftCardProductId,
  providerId: "bitcoinCompany",
  providerProductId: "amazon-us",
  name: "Amazon US",
  brand: "Amazon",
  countryCode: "US",
  currency: "USD",
  denominationType: "variable",
  denominations: [],
  minValue: 500,
  maxValue: 50_000,
  isOpenLoop: false,
  categories: ["shopping"],
  logoUrl: null,
  termsUrl: null,
  rewardBps: 100,
  inStock: true,
  maxQuantity: 10,
  wholeUnitsOnly: false,
  ...overrides,
})

export const makeAccount = (overrides: Record<string, unknown> = {}): Account =>
  ({
    id: ACCOUNT_ID,
    level: 1,
    createdAt: new Date(NOW_MS - 7 * DAY_MS),
    kratosUserId: "kratos-1",
    displayCurrency: "USD",
    username: "jaceth2009",
    ...overrides,
  }) as unknown as Account

export const makeWallet = (overrides: Record<string, unknown> = {}): Wallet =>
  ({
    id: WALLET_ID,
    accountId: ACCOUNT_ID,
    currency: "BTC",
    type: "checking",
    ...overrides,
  }) as unknown as Wallet

export const makeOrder = (overrides: Partial<GiftCardOrder> = {}): GiftCardOrder => {
  const status = overrides.status ?? "CREATED"
  return {
    id: "order-1" as GiftCardOrderId,
    accountId: ACCOUNT_ID,
    walletId: WALLET_ID,
    walletCurrency: "BTC",
    providerId: "bitcoinCompany",
    providerProductId: "amazon-us",
    providerOrderId: null,
    productSnapshot: {
      name: "Amazon US",
      brand: "Amazon",
      countryCode: "US",
      currency: "USD",
      isOpenLoop: false,
      logoUrl: null,
    },
    valueMinor: 2500,
    currency: "USD",
    quantity: 1,
    quoteSats: 40_000 as Satoshis,
    invoiceSats: null,
    paidSats: null,
    paymentRequest: null,
    paymentHash: null,
    providerPaymentRef: null,
    idempotencyKey: "idem-1",
    status,
    statusHistory: [{ status, at: new Date(NOW_MS), reason: null }],
    claimCiphertext: null,
    claimKeyId: null,
    fulfilledAt: null,
    failureReason: null,
    expiresAt: new Date(NOW_MS + 15 * 60 * 1000),
    createdAt: new Date(NOW_MS),
    updatedAt: new Date(NOW_MS),
    ...overrides,
  }
}

export const makeLimitsConfig = (overrides: Record<string, unknown> = {}) => ({
  mode: "enforce" as GiftCardLimitsMode,
  minAccountLevel: 1,
  minAccountAgeHours: 24,
  maxOrdersPerHour: 5,
  vendorDailyCapCents: 1_000_000,
  vendorOpenLoopCardCapCents: 100_000,
  vendorClosedLoopCardCapCents: 200_000,
  perLevel: {
    level0: { perCardCents: 0, dailyCents: 0 },
    level1: { perCardCents: 20_000, dailyCents: 50_000 },
    level2: { perCardCents: 100_000, dailyCents: 250_000 },
    level3: { perCardCents: 200_000, dailyCents: 1_000_000 },
  },
  ...overrides,
})

export const makeGiftCardsConfig = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  allowOpenLoop: true,
  feeBps: 0,
  claimDataEncryptionKey: "",
  quoteToleranceBps: 100,
  routing: { default: "bitcoinCompany", byCountry: {} as Record<string, string> },
  providers: {
    bitcoinCompany: {
      enabled: true,
      baseUrl: "https://api.dev.thebitcoincompany.com",
      email: "",
      password: "",
      referralCode: "",
      timeoutMs: 10_000,
    },
    bitrefill: {
      enabled: false,
      baseUrl: "",
      apiId: "",
      apiSecret: "",
      webhookSecret: "",
      timeoutMs: 10_000,
    },
  },
  catalog: { syncIntervalSeconds: 21_600, ttlSeconds: 21_600, staleAfterSeconds: 86_400 },
  limits: makeLimitsConfig(),
  ...overrides,
})

/**
 * In-memory `GiftCardOrdersRepository` with the real transition semantics:
 * every `from` → `to` must be legal per the domain table (the same
 * `checkGiftCardOrderTransition` the real repository runs before touching
 * Mongo, so an illegal transition fails here the way it fails in prod), `from`
 * must include the current status, the patch is applied, the history grows,
 * `updatedAt` moves. Every method is a `jest.fn` so specs can assert calls or
 * override one method for a single test. Return types are widened to the real
 * repository's (`| RepositoryError`) so a spec can mock a store fault without
 * casting.
 */
export const makeFakeOrdersRepo = () => {
  const store = new Map<string, GiftCardOrder>()
  let seq = 0

  const now = () => new Date(Date.now())

  type Found = GiftCardOrder | GiftCardOrderNotFoundError | RepositoryError
  type Listed = GiftCardOrder[] | RepositoryError
  type Transitioned =
    GiftCardOrder | GiftCardOrderStateError | GiftCardOrderNotFoundError | RepositoryError

  const repo = {
    store,
    seed: (order: GiftCardOrder) => {
      store.set(order.id, order)
      return order
    },
    create: jest.fn(
      async (args: Record<string, unknown>): Promise<GiftCardOrder | RepositoryError> => {
        seq += 1
        const order = makeOrder({
          ...(args as Partial<GiftCardOrder>),
          id: `order-${seq}` as GiftCardOrderId,
          status: "CREATED",
          statusHistory: [{ status: "CREATED", at: now(), reason: null }],
          createdAt: now(),
          updatedAt: now(),
        })
        store.set(order.id, order)
        return order
      },
    ),
    findById: jest.fn(
      async (id: string): Promise<Found> =>
        store.get(id) ?? new GiftCardOrderNotFoundError(),
    ),
    findByIdempotencyKey: jest.fn(
      async ({
        walletId,
        idempotencyKey,
      }: {
        walletId: string
        idempotencyKey: string
      }): Promise<Found> =>
        [...store.values()].find(
          (o) => o.walletId === walletId && o.idempotencyKey === idempotencyKey,
        ) ?? new GiftCardOrderNotFoundError(),
    ),
    findByProviderOrderId: jest.fn(
      async ({ providerOrderId }: { providerOrderId: string }): Promise<Found> =>
        [...store.values()].find((o) => o.providerOrderId === providerOrderId) ??
        new GiftCardOrderNotFoundError(),
    ),
    listByAccount: jest.fn(
      async ({
        accountId,
        limit,
        before,
      }: {
        accountId: string
        limit: number
        before?: Date
      }): Promise<Listed> =>
        [...store.values()]
          .filter((o) => o.accountId === accountId)
          .filter((o) => !before || o.createdAt < before)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, limit),
    ),
    listByStatus: jest.fn(
      async ({
        statuses,
        limit,
      }: {
        statuses: GiftCardOrderStatus[]
        limit: number
      }): Promise<Listed> =>
        [...store.values()].filter((o) => statuses.includes(o.status)).slice(0, limit),
    ),
    transition: jest.fn(
      async ({
        id,
        from,
        to,
        reason,
        patch,
      }: {
        id: string
        from: GiftCardOrderStatus[]
        to: GiftCardOrderStatus
        reason?: string
        patch?: Partial<GiftCardOrder>
      }): Promise<Transitioned> => {
        const allowed = checkGiftCardOrderTransition(from, to)
        if (allowed instanceof Error) return allowed
        const current = store.get(id)
        if (!current) return new GiftCardOrderNotFoundError()
        if (!from.includes(current.status)) {
          return new GiftCardOrderStateError(`${current.status} -> ${to} not allowed`)
        }
        const next: GiftCardOrder = {
          ...current,
          ...patch,
          status: to,
          statusHistory: [
            ...current.statusHistory,
            { status: to, at: now(), reason: reason ?? null },
          ],
          updatedAt: now(),
        }
        store.set(id, next)
        return next
      },
    ),
    touch: jest.fn(
      async (
        id: string,
      ): Promise<true | GiftCardOrderNotFoundError | RepositoryError> => {
        const current = store.get(id)
        if (!current) return new GiftCardOrderNotFoundError()
        store.set(id, { ...current, updatedAt: now() })
        return true
      },
    ),
  }
  return repo
}

export type FakeOrdersRepo = ReturnType<typeof makeFakeOrdersRepo>

/** Every string that went through a mock, for "the claim never leaked" assertions. */
export const allMockCallText = (...mocks: jest.Mock[]): string =>
  mocks.map((m) => JSON.stringify(m.mock.calls)).join("\n")
