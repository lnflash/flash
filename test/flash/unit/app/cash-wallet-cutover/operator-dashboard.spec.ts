import {
  buildCashWalletCutoverOperatorSnapshot,
  formatCashWalletCutoverOperatorSnapshotCsv,
  parseCashWalletCutoverOperatorManifest,
} from "@app/cash-wallet-cutover/operator-dashboard"
import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"

const account = ({
  id,
  defaultWalletId,
  uuid,
  role,
}: {
  id: AccountId
  defaultWalletId: WalletId
  uuid?: AccountUuid
  role?: string
}): Account =>
  ({
    id,
    uuid,
    defaultWalletId,
    role,
  }) as Account

const wallet = ({
  id,
  accountId,
  currency,
}: {
  id: WalletId
  accountId: AccountId
  currency: WalletCurrency
}): Wallet => ({
  id,
  accountId,
  currency,
  type: WalletType.Checking,
  onChainAddressIdentifiers: [],
  onChainAddresses: () => [],
  lnurlp: "" as Lnurl,
})

describe("cash wallet cutover operator dashboard", () => {
  it("parses both generated manifest shapes", () => {
    expect(
      parseCashWalletCutoverOperatorManifest({
        runId: "eng345usd",
        accounts: [
          {
            index: 1,
            phone: "+16509940000",
            username: "eng345usd01",
            accountId: "account-1",
            usdWalletId: "usd-1",
            usdtWalletId: "usdt-1",
          },
        ],
      }),
    ).toEqual([
      {
        batchRunId: "eng345usd",
        index: 1,
        phone: "+16509940000",
        username: "eng345usd01",
        accountId: "account-1",
        expectedUsdWalletId: "usd-1",
        expectedUsdtWalletId: "usdt-1",
      },
    ])

    expect(
      parseCashWalletCutoverOperatorManifest({
        runId: "eng345usdonly",
        created: [
          {
            index: 1,
            phone: "+16509941000",
            accountId: "account-2",
            usdWalletId: "usd-2",
          },
        ],
      }),
    ).toEqual([
      {
        batchRunId: "eng345usdonly",
        index: 1,
        phone: "+16509941000",
        accountId: "account-2",
        expectedUsdWalletId: "usd-2",
      },
    ])
  })

  it("formats the full operator snapshot as escaped account-level CSV", () => {
    const csv = formatCashWalletCutoverOperatorSnapshotCsv({
      generatedAt: "2026-05-28T20:00:00.000Z",
      cutover: {
        state: "in_progress" as CashWalletCutoverState,
        cutoverVersion: 7,
        runId: "run-7",
        updatedAt: "2026-05-28T19:59:00.000Z",
      },
      summary: {
        accounts: 1,
        wallets: {
          current: 2,
          target: 2,
          usd: 1,
          usdt: 1,
          missingUsdt: 0,
        },
        fundedUsdOnlyAccounts: 0,
        usdTotalCents: 123,
        usdtTotalMicros: 456_000,
        anomalies: 1,
        watchlistAnomalies: 1,
        canStart: false,
        blockers: 0,
        watchlistAccounts: 1,
        migrationStatuses: { complete: 1 },
      },
      accounts: [
        {
          batchRunId: "batch,one",
          index: 1,
          phone: "+16509940000",
          username: 'quoted"user',
          accountId: "account-1" as AccountId,
          accountUuid: "uuid-1" as AccountUuid,
          expectedUsdWalletId: "usd-1" as WalletId,
          expectedUsdtWalletId: "usdt-1" as WalletId,
          watchlisted: true,
          defaultWalletId: "usd-1" as WalletId,
          defaultWalletCurrency: WalletCurrency.Usd,
          walletCount: 2,
          usdWallets: [
            {
              id: "usd-1" as WalletId,
              currency: WalletCurrency.Usd,
              expected: true,
              balance: {
                currency: WalletCurrency.Usd,
                display: "$1.23",
                minorUnits: "123",
                minorUnitsNumber: 123,
                status: "fresh",
              },
            },
          ],
          usdtWallets: [
            {
              id: "usdt-1" as WalletId,
              currency: WalletCurrency.Usdt,
              expected: true,
              balance: {
                currency: WalletCurrency.Usdt,
                display: "0.46 USDT",
                minorUnits: "456000",
                minorUnitsNumber: 456000,
                status: "fresh",
              },
            },
          ],
          migrationStatus: "complete",
          migrationUpdatedAt: "2026-05-28T20:00:00.000Z",
          cutoverBalanceAudit: {
            status: "verified",
            sourceUsdCents: 123,
            expectedMinimumUsdtMicros: 1_230_000,
            destinationStartingBalanceUsdtMicros: 0,
            currentDestinationBalanceUsdtMicros: 1_240_000,
            finalDeltaUsdtMicros: 1_240_000,
            roundingSubsidyUsdtMicros: 10_000,
            shortfallUsdtMicros: 0,
          },
          anomalies: ["manual,review"],
        },
      ],
    })

    expect(csv.split("\n")[0]).toBe(
      [
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
      ].join(","),
    )
    expect(csv).toContain('"batch,one"')
    expect(csv).toContain('"quoted""user"')
    expect(csv).toContain('"manual,review"')
    expect(csv).toContain("usd-1")
    expect(csv).toContain("usdt-1")
    expect(csv).toContain("roundingSubsidyUsdtMicros=10000")
  })

  it("summarizes raw wallets, balances, migrations, and anomalies", async () => {
    const usdTenCents = USDAmount.cents(10n)
    const usdtTwentyFiveCents = USDTAmount.smallestUnits(250_000n)
    if (usdTenCents instanceof Error) throw usdTenCents
    if (usdtTwentyFiveCents instanceof Error) throw usdtTwentyFiveCents

    const accounts = new Map([
      [
        "account-1",
        account({
          id: "account-1" as AccountId,
          uuid: "uuid-1" as AccountUuid,
          defaultWalletId: "usd-1" as WalletId,
        }),
      ],
      [
        "account-2",
        account({
          id: "account-2" as AccountId,
          uuid: "uuid-2" as AccountUuid,
          defaultWalletId: "usd-2" as WalletId,
        }),
      ],
    ])

    const wallets = new Map([
      [
        "account-1",
        [
          wallet({
            id: "usd-1" as WalletId,
            accountId: "account-1" as AccountId,
            currency: WalletCurrency.Usd,
          }),
          wallet({
            id: "usdt-1" as WalletId,
            accountId: "account-1" as AccountId,
            currency: WalletCurrency.Usdt,
          }),
        ],
      ],
      [
        "account-2",
        [
          wallet({
            id: "usd-2" as WalletId,
            accountId: "account-2" as AccountId,
            currency: WalletCurrency.Usd,
          }),
        ],
      ],
    ])

    const snapshot = await buildCashWalletCutoverOperatorSnapshot({
      manifestAccounts: [
        {
          batchRunId: "batch",
          index: 1,
          phone: "+16509940000",
          accountId: "account-1" as AccountId,
        },
        {
          batchRunId: "batch",
          index: 2,
          phone: "+16509941000",
          accountId: "account-2" as AccountId,
        },
      ],
      accountsRepo: {
        findById: jest.fn(async (id: AccountId) => accounts.get(id) as Account),
      },
      walletsRepo: {
        listByAccountId: jest.fn(async (id: AccountId) => wallets.get(id) ?? []),
      },
      migrationsRepo: {
        getConfig: jest.fn(async () => ({
          state: "in_progress" as CashWalletCutoverState,
          cutoverVersion: 7,
          runId: "run-7",
          updatedAt: new Date("2026-05-26T20:00:00.000Z"),
        })),
        findMigrationByAccountId: jest.fn(
          async ({ accountId }: { accountId: AccountId }) =>
            accountId === "account-1"
              ? {
                  id: "migration-1",
                  accountId,
                  legacyUsdWalletId: "usd-1" as WalletId,
                  destinationUsdtWalletId: "usdt-1" as WalletId,
                  cutoverVersion: 7,
                  runId: "run-7",
                  status: "complete" as CashWalletMigrationStatus,
                  idempotencyKey: "key",
                  attempts: 1,
                  updatedAt: new Date("2026-05-26T20:00:00.000Z"),
                }
              : null,
        ),
      },
      getBalanceForWallet: jest.fn(async ({ walletId }: { walletId: WalletId }) =>
        walletId === "usdt-1" ? usdtTwentyFiveCents : usdTenCents,
      ),
      preflightReport: {
        cutoverVersion: 7,
        runId: "run-7",
        totalAccounts: 101,
        migrationCandidates: 81,
        alreadyUsdt: 10,
        residualLegacyUsd: 0,
        blockers: 10,
        blockerAccounts: [],
        canStart: false,
      },
      now: new Date("2026-05-26T20:01:00.000Z"),
    })

    expect(snapshot.preflight).toMatchObject({
      totalAccounts: 101,
      migrationCandidates: 81,
      blockers: 10,
      canStart: false,
    })
    expect(snapshot.summary.accounts).toBe(2)
    expect(snapshot.summary.wallets.current).toBe(3)
    expect(snapshot.summary.wallets.target).toBe(4)
    expect(snapshot.summary.wallets.missingUsdt).toBe(1)
    expect(snapshot.summary.canStart).toBe(false)
    expect(snapshot.summary.blockers).toBe(1)
    expect(snapshot.summary.fundedUsdOnlyAccounts).toBe(1)
    expect(snapshot.summary.usdTotalCents).toBe(20)
    expect(snapshot.summary.usdtTotalMicros).toBe(250000)
    expect(snapshot.summary.migrationStatuses).toEqual({ complete: 1, none: 1 })
    expect(snapshot.accounts[1].anomalies).toContain("missing_usdt")
  })

  it("reports completed migration final balance audit fields", async () => {
    const zeroUsd = USDAmount.cents(0n)
    const finalUsdt = USDTAmount.smallestUnits(108_000n)
    if (zeroUsd instanceof Error) throw zeroUsd
    if (finalUsdt instanceof Error) throw finalUsdt

    const snapshot = await buildCashWalletCutoverOperatorSnapshot({
      manifestAccounts: [
        {
          index: 1,
          accountId: "account-1" as AccountId,
          expectedUsdWalletId: "usd-1" as WalletId,
          expectedUsdtWalletId: "usdt-1" as WalletId,
        },
      ],
      accountsRepo: {
        findById: jest.fn(async () =>
          account({
            id: "account-1" as AccountId,
            defaultWalletId: "usdt-1" as WalletId,
          }),
        ),
      },
      walletsRepo: {
        listByAccountId: jest.fn(async () => [
          wallet({
            id: "usd-1" as WalletId,
            accountId: "account-1" as AccountId,
            currency: WalletCurrency.Usd,
          }),
          wallet({
            id: "usdt-1" as WalletId,
            accountId: "account-1" as AccountId,
            currency: WalletCurrency.Usdt,
          }),
        ]),
      },
      migrationsRepo: {
        getConfig: jest.fn(async () => ({
          state: "complete" as CashWalletCutoverState,
          cutoverVersion: 7,
          runId: "run-7",
          updatedAt: new Date("2026-05-26T20:00:00.000Z"),
        })),
        findMigrationByAccountId: jest.fn(async () => ({
          id: "migration-1",
          accountId: "account-1" as AccountId,
          legacyUsdWalletId: "usd-1" as WalletId,
          destinationUsdtWalletId: "usdt-1" as WalletId,
          cutoverVersion: 7,
          runId: "run-7",
          status: "complete" as CashWalletMigrationStatus,
          sourceBalanceUsdCents: "10",
          destinationAmountUsdtMicros: "100000",
          destinationStartingBalanceUsdtMicros: "0",
          feeAmountUsdtMicros: "2000",
          feeAmountUsdCents: "1",
          idempotencyKey: "key",
          attempts: 1,
          updatedAt: new Date("2026-05-26T20:00:00.000Z"),
        })),
      },
      getBalanceForWallet: jest.fn(async ({ currency }: { currency?: WalletCurrency }) =>
        currency === WalletCurrency.Usdt ? finalUsdt : zeroUsd,
      ),
      now: new Date("2026-05-26T20:01:00.000Z"),
    })

    expect(snapshot.accounts[0].cutoverBalanceAudit).toEqual({
      status: "verified",
      sourceUsdCents: 10,
      expectedMinimumUsdtMicros: 100_000,
      destinationStartingBalanceUsdtMicros: 0,
      currentDestinationBalanceUsdtMicros: 108_000,
      finalDeltaUsdtMicros: 108_000,
      roundingSubsidyUsdtMicros: 8_000,
      shortfallUsdtMicros: 0,
    })
  })

  it("does not report an audit shortfall while destination balances are still loading", async () => {
    const snapshot = await buildCashWalletCutoverOperatorSnapshot({
      manifestAccounts: [
        {
          index: 1,
          accountId: "account-1" as AccountId,
          expectedUsdWalletId: "usd-1" as WalletId,
          expectedUsdtWalletId: "usdt-1" as WalletId,
        },
      ],
      accountsRepo: {
        findById: jest.fn(async () =>
          account({
            id: "account-1" as AccountId,
            defaultWalletId: "usdt-1" as WalletId,
          }),
        ),
      },
      walletsRepo: {
        listByAccountId: jest.fn(async () => [
          wallet({
            id: "usd-1" as WalletId,
            accountId: "account-1" as AccountId,
            currency: WalletCurrency.Usd,
          }),
          wallet({
            id: "usdt-1" as WalletId,
            accountId: "account-1" as AccountId,
            currency: WalletCurrency.Usdt,
          }),
        ]),
      },
      migrationsRepo: {
        getConfig: jest.fn(async () => ({
          state: "complete" as CashWalletCutoverState,
          cutoverVersion: 7,
          runId: "run-7",
          updatedAt: new Date("2026-05-26T20:00:00.000Z"),
        })),
        findMigrationByAccountId: jest.fn(async () => ({
          id: "migration-1",
          accountId: "account-1" as AccountId,
          legacyUsdWalletId: "usd-1" as WalletId,
          destinationUsdtWalletId: "usdt-1" as WalletId,
          cutoverVersion: 7,
          runId: "run-7",
          status: "complete" as CashWalletMigrationStatus,
          sourceBalanceUsdCents: "10",
          destinationAmountUsdtMicros: "100000",
          destinationStartingBalanceUsdtMicros: "0",
          idempotencyKey: "key",
          attempts: 1,
          updatedAt: new Date("2026-05-26T20:00:00.000Z"),
        })),
      },
      getBalanceForWallet: jest.fn(),
      balanceMode: "structural",
      now: new Date("2026-05-26T20:01:00.000Z"),
    })

    expect(snapshot.accounts[0].cutoverBalanceAudit).toMatchObject({
      status: "loading",
      finalDeltaUsdtMicros: 0,
      roundingSubsidyUsdtMicros: 0,
      shortfallUsdtMicros: 0,
    })
  })

  it("includes funder balances in reconciliation without adding migration rows", async () => {
    const customerUsd = USDAmount.cents(452n)
    const customerUsdt = USDTAmount.smallestUnits(45_200_00n)
    const funderUsd = USDAmount.cents(418n)
    const funderUsdt = USDTAmount.smallestUnits(9_900_000n)
    if (customerUsd instanceof Error) throw customerUsd
    if (customerUsdt instanceof Error) throw customerUsdt
    if (funderUsd instanceof Error) throw funderUsd
    if (funderUsdt instanceof Error) throw funderUsdt

    const accounts = new Map([
      [
        "customer-account",
        account({
          id: "customer-account" as AccountId,
          defaultWalletId: "customer-usdt" as WalletId,
        }),
      ],
      [
        "funder-account",
        account({
          id: "funder-account" as AccountId,
          defaultWalletId: "funder-usd" as WalletId,
          role: "funder",
        }),
      ],
    ])

    const wallets = new Map([
      [
        "customer-account",
        [
          wallet({
            id: "customer-usd" as WalletId,
            accountId: "customer-account" as AccountId,
            currency: WalletCurrency.Usd,
          }),
          wallet({
            id: "customer-usdt" as WalletId,
            accountId: "customer-account" as AccountId,
            currency: WalletCurrency.Usdt,
          }),
        ],
      ],
      [
        "funder-account",
        [
          wallet({
            id: "funder-usd" as WalletId,
            accountId: "funder-account" as AccountId,
            currency: WalletCurrency.Usd,
          }),
          wallet({
            id: "funder-usdt" as WalletId,
            accountId: "funder-account" as AccountId,
            currency: WalletCurrency.Usdt,
          }),
        ],
      ],
    ])

    const snapshot = await buildCashWalletCutoverOperatorSnapshot({
      manifestAccounts: [],
      discoveredAccounts: [
        {
          status: "usdt_default",
          accountId: "customer-account" as AccountId,
          legacyUsdWalletId: "customer-usd" as WalletId,
          destinationUsdtWalletId: "customer-usdt" as WalletId,
          previousDefaultWalletId: "customer-usd" as WalletId,
        },
      ],
      treasuryAccountIds: ["funder-account" as AccountId],
      accountsRepo: {
        findById: jest.fn(async (id: AccountId) => accounts.get(id) as Account),
      },
      walletsRepo: {
        listByAccountId: jest.fn(async (id: AccountId) => wallets.get(id) ?? []),
      },
      migrationsRepo: {
        getConfig: jest.fn(async () => ({
          state: "complete" as CashWalletCutoverState,
          cutoverVersion: 7,
          runId: "run-7",
          updatedAt: new Date("2026-05-26T20:00:00.000Z"),
        })),
        findMigrationByAccountId: jest.fn(async () => null),
      },
      getBalanceForWallet: jest.fn(async ({ walletId }: { walletId: WalletId }) => {
        if (walletId === "customer-usd") return customerUsd
        if (walletId === "customer-usdt") return customerUsdt
        if (walletId === "funder-usd") return funderUsd
        return funderUsdt
      }),
      now: new Date("2026-05-26T20:01:00.000Z"),
    })

    expect(snapshot.accounts.map((row) => row.accountId)).toEqual([
      "customer-account",
    ])
    expect(snapshot.treasury.accounts.map((row) => row.accountId)).toEqual([
      "funder-account",
    ])
    expect(snapshot.summary.usdTotalCents).toBe(452)
    expect(snapshot.summary.usdtTotalMicros).toBe(4_520_000)
    expect(snapshot.treasury.summary.usdTotalCents).toBe(418)
    expect(snapshot.treasury.summary.usdtTotalMicros).toBe(9_900_000)
    expect(snapshot.reconciliation.customerTotalCents).toBe(904)
    expect(snapshot.reconciliation.treasuryTotalCents).toBe(1_408)
    expect(snapshot.reconciliation.systemTotalCents).toBe(2_312)
  })

  it("uses global discoveries as dashboard rows while highlighting manifest accounts", async () => {
    const zeroUsd = USDAmount.cents(0n)
    const zeroUsdt = USDTAmount.smallestUnits(0n)
    if (zeroUsd instanceof Error) throw zeroUsd
    if (zeroUsdt instanceof Error) throw zeroUsdt

    const accounts = new Map([
      [
        "watchlist-account",
        account({
          id: "watchlist-account" as AccountId,
          uuid: "watchlist-uuid" as AccountUuid,
          defaultWalletId: "watchlist-usd" as WalletId,
        }),
      ],
      [
        "global-account",
        account({
          id: "global-account" as AccountId,
          uuid: "global-uuid" as AccountUuid,
          defaultWalletId: "global-usd" as WalletId,
        }),
      ],
    ])

    const wallets = new Map([
      [
        "watchlist-account",
        [
          wallet({
            id: "watchlist-usd" as WalletId,
            accountId: "watchlist-account" as AccountId,
            currency: WalletCurrency.Usd,
          }),
          wallet({
            id: "watchlist-usdt" as WalletId,
            accountId: "watchlist-account" as AccountId,
            currency: WalletCurrency.Usdt,
          }),
        ],
      ],
      [
        "global-account",
        [
          wallet({
            id: "global-usd" as WalletId,
            accountId: "global-account" as AccountId,
            currency: WalletCurrency.Usd,
          }),
          wallet({
            id: "global-usdt" as WalletId,
            accountId: "global-account" as AccountId,
            currency: WalletCurrency.Usdt,
          }),
          wallet({
            id: "global-extra-usd" as WalletId,
            accountId: "global-account" as AccountId,
            currency: WalletCurrency.Usd,
          }),
        ],
      ],
    ])

    const snapshot = await buildCashWalletCutoverOperatorSnapshot({
      manifestAccounts: [
        {
          batchRunId: "batch",
          index: 1,
          phone: "+16509940000",
          accountId: "watchlist-account" as AccountId,
          expectedUsdWalletId: "watchlist-usd" as WalletId,
          expectedUsdtWalletId: "watchlist-usdt" as WalletId,
        },
      ],
      discoveredAccounts: [
        {
          status: "legacy_default",
          accountId: "watchlist-account" as AccountId,
          accountUuid: "watchlist-uuid" as AccountUuid,
          legacyUsdWalletId: "watchlist-usd" as WalletId,
          destinationUsdtWalletId: "watchlist-usdt" as WalletId,
          previousDefaultWalletId: "watchlist-usd" as WalletId,
        },
        {
          status: "legacy_default",
          accountId: "global-account" as AccountId,
          accountUuid: "global-uuid" as AccountUuid,
          legacyUsdWalletId: "global-usd" as WalletId,
          destinationUsdtWalletId: "global-usdt" as WalletId,
          previousDefaultWalletId: "global-usd" as WalletId,
        },
      ],
      accountsRepo: {
        findById: jest.fn(async (id: AccountId) => accounts.get(id) as Account),
      },
      walletsRepo: {
        listByAccountId: jest.fn(async (id: AccountId) => wallets.get(id) ?? []),
      },
      migrationsRepo: {
        getConfig: jest.fn(async () => ({
          state: "pre" as CashWalletCutoverState,
          cutoverVersion: 7,
          runId: "run-7",
          updatedAt: new Date("2026-05-26T20:00:00.000Z"),
        })),
        findMigrationByAccountId: jest.fn(async () => null),
      },
      getBalanceForWallet: jest.fn(async ({ currency }: { currency?: WalletCurrency }) =>
        currency === WalletCurrency.Usdt ? zeroUsdt : zeroUsd,
      ),
      now: new Date("2026-05-26T20:01:00.000Z"),
    })

    expect(snapshot.summary.accounts).toBe(2)
    expect(snapshot.summary.watchlistAccounts).toBe(1)
    expect(snapshot.summary.anomalies).toBe(1)
    expect(snapshot.summary.watchlistAnomalies).toBe(0)
    expect(snapshot.accounts.map((row) => row.accountId)).toEqual([
      "watchlist-account",
      "global-account",
    ])
    expect(snapshot.accounts[0].watchlisted).toBe(true)
    expect(snapshot.accounts[0].phone).toBe("+16509940000")
    expect(snapshot.accounts[1].watchlisted).toBe(false)
    expect(snapshot.accounts[1].expectedUsdWalletId).toBe("global-usd")
    expect(snapshot.accounts[1].expectedUsdtWalletId).toBe("global-usdt")
    expect(snapshot.accounts[1].anomalies).toContain("duplicate_usd")
    expect(snapshot.accounts[1].anomalies).toContain("unexpected_wallet_id")
  })

  it("retries transient balance read errors before marking a wallet anomalous", async () => {
    const balance = USDAmount.cents(10n)
    if (balance instanceof Error) throw balance

    const getBalanceForWallet = jest
      .fn()
      .mockResolvedValueOnce(new Error("temporary ibex failure"))
      .mockResolvedValueOnce(balance)

    const snapshot = await buildCashWalletCutoverOperatorSnapshot({
      manifestAccounts: [
        {
          index: 1,
          phone: "+16509941000",
          accountId: "account-1" as AccountId,
        },
      ],
      accountsRepo: {
        findById: jest.fn(async () =>
          account({
            id: "account-1" as AccountId,
            defaultWalletId: "usd-1" as WalletId,
          }),
        ),
      },
      walletsRepo: {
        listByAccountId: jest.fn(async () => [
          wallet({
            id: "usd-1" as WalletId,
            accountId: "account-1" as AccountId,
            currency: WalletCurrency.Usd,
          }),
        ]),
      },
      migrationsRepo: {
        getConfig: jest.fn(async () => ({
          state: "complete" as CashWalletCutoverState,
          cutoverVersion: 7,
          runId: "run-7",
          updatedAt: new Date("2026-05-26T20:00:00.000Z"),
        })),
        findMigrationByAccountId: jest.fn(async () => null),
      },
      getBalanceForWallet,
      balanceReadAttempts: 2,
      now: new Date("2026-05-26T20:01:00.000Z"),
    })

    expect(getBalanceForWallet).toHaveBeenCalledTimes(2)
    expect(snapshot.accounts[0].usdWallets[0].balance.display).toBe("$0.10")
    expect(snapshot.accounts[0].anomalies).toEqual(["missing_usdt"])
  })

  it("builds a structural snapshot without reading wallet balances", async () => {
    const getBalanceForWallet = jest.fn()

    const snapshot = await buildCashWalletCutoverOperatorSnapshot({
      manifestAccounts: [
        {
          index: 1,
          phone: "+16509941000",
          accountId: "account-1" as AccountId,
          expectedUsdWalletId: "usd-1" as WalletId,
        },
      ],
      accountsRepo: {
        findById: jest.fn(async () =>
          account({
            id: "account-1" as AccountId,
            defaultWalletId: "usd-1" as WalletId,
          }),
        ),
      },
      walletsRepo: {
        listByAccountId: jest.fn(async () => [
          wallet({
            id: "usd-1" as WalletId,
            accountId: "account-1" as AccountId,
            currency: WalletCurrency.Usd,
          }),
        ]),
      },
      migrationsRepo: {
        getConfig: jest.fn(async () => ({
          state: "in_progress" as CashWalletCutoverState,
          cutoverVersion: 7,
          runId: "run-7",
          updatedAt: new Date("2026-05-26T20:00:00.000Z"),
        })),
        findMigrationByAccountId: jest.fn(async () => null),
      },
      getBalanceForWallet,
      balanceMode: "structural",
      now: new Date("2026-05-26T20:01:00.000Z"),
    })

    expect(getBalanceForWallet).not.toHaveBeenCalled()
    expect(snapshot.summary.wallets.current).toBe(1)
    expect(snapshot.summary.usdTotalCents).toBe(0)
    expect(snapshot.summary.fundedUsdOnlyAccounts).toBe(0)
    expect(snapshot.accounts[0].usdWallets[0]).toMatchObject({
      id: "usd-1",
      balance: {
        status: "loading",
        display: "loading",
        minorUnitsNumber: 0,
      },
    })
    expect(snapshot.accounts[0].anomalies).toEqual(["missing_usdt"])
  })
})
