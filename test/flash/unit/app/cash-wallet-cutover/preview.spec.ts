jest.mock("@services/mongoose", () => ({
  AccountsRepository: jest.fn(),
  WalletsRepository: jest.fn(),
}))

import { previewPrimaryCashWalletCutover } from "@app/cash-wallet-cutover/preview"
import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"

const account = ({
  id,
  defaultWalletId,
}: {
  id: string
  defaultWalletId: string
}): Account =>
  ({
    id,
    uuid: `${id}-uuid`,
    defaultWalletId,
  }) as Account

const wallet = ({ id, currency }: { id: string; currency: WalletCurrency }): Wallet =>
  ({
    id,
    type: WalletType.Checking,
    currency,
  }) as Wallet

describe("preview primary cash wallet cutover", () => {
  it("builds the preflight report and plan without repository writes", async () => {
    const accounts = [
      account({ id: "account-1", defaultWalletId: "usd-1" }),
      account({ id: "account-2", defaultWalletId: "usdt-2" }),
    ]

    const accountsRepo = {
      listUnlockedAccounts: function* () {
        yield* accounts
      },
    }
    const walletsRepo = {
      listByAccountId: jest.fn(async (accountId: AccountId) => {
        if (accountId === "account-1") {
          return [
            wallet({ id: "usd-1", currency: WalletCurrency.Usd }),
            wallet({ id: "usdt-1", currency: WalletCurrency.Usdt }),
          ]
        }

        return [
          wallet({ id: "usd-2", currency: WalletCurrency.Usd }),
          wallet({ id: "usdt-2", currency: WalletCurrency.Usdt }),
        ]
      }),
    }

    const result = await previewPrimaryCashWalletCutover({
      cutoverVersion: 7,
      runId: "run-7",
      accountsRepo,
      walletsRepo,
    })

    expect(result).toEqual({
      report: expect.objectContaining({
        totalAccounts: 2,
        migrationCandidates: 1,
        alreadyUsdt: 1,
        canStart: true,
      }),
      plannedMigrations: [
        expect.objectContaining({
          accountId: "account-1",
          legacyUsdWalletId: "usd-1",
          destinationUsdtWalletId: "usdt-1",
        }),
      ],
    })
  })
})
