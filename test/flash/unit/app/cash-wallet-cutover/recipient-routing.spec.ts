import { resolveCashWalletRecipientMutationWalletId } from "@app/cash-wallet-cutover/recipient-routing"
import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"

const recipientAccountId = "recipient-account-id" as AccountId
const recipientWalletId = "11111111-1111-4111-8111-111111111111" as WalletId
const routedWalletId = "22222222-2222-4222-8222-222222222222" as WalletId

const recipientWallet = {
  id: recipientWalletId,
  accountId: recipientAccountId,
  currency: WalletCurrency.Usd,
  type: WalletType.Checking,
  onChainAddressIdentifiers: [],
  onChainAddresses: () => [],
  lnurlp: "lnurlp-recipient" as Lnurl,
} as Wallet

const recipientAccount = {
  id: recipientAccountId,
  uuid: "recipient-account-uuid" as AccountUuid,
} as Account

const client = {
  cashWalletPresentation: "usdt",
  hasUsdtCashWalletSupport: true,
} as const

describe("resolveCashWalletRecipientMutationWalletId", () => {
  it("routes recipient legacy USD wallet ids through the recipient account presentation", async () => {
    const walletsRepo = {
      findById: jest.fn().mockResolvedValue(recipientWallet),
      listByAccountId: jest.fn(),
    }
    const accountsRepo = {
      findById: jest.fn().mockResolvedValue(recipientAccount),
    }
    const resolveMutationWalletIdForAccount = jest.fn().mockResolvedValue(routedWalletId)

    const result = await resolveCashWalletRecipientMutationWalletId({
      recipientWalletId,
      client,
      walletsRepo,
      accountsRepo,
      resolveMutationWalletIdForAccount,
    })

    expect(result).toBe(routedWalletId)
    expect(walletsRepo.findById).toHaveBeenCalledWith(recipientWalletId)
    expect(accountsRepo.findById).toHaveBeenCalledWith(recipientAccountId)
    expect(resolveMutationWalletIdForAccount).toHaveBeenCalledWith({
      account: recipientAccount,
      walletId: recipientWalletId,
      client,
      walletsRepo,
    })
  })
})
