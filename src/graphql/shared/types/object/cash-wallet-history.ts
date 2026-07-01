import {
  CashWalletClientCapabilities,
  cashWalletHistoryWalletsForPresentation,
  resolveCashWalletPresentationForAccount,
} from "@app/cash-wallet-cutover"
import { WalletType } from "@domain/wallets"
import { mapError } from "@graphql/error-map"

type CashWalletHistoryContext = {
  domainAccount?: Account
  cashWalletClientCapabilities?: CashWalletClientCapabilities
}

export const resolveCashWalletHistoryWalletsForWalletObject = async ({
  source,
  ctx,
}: {
  source: Wallet
  ctx: CashWalletHistoryContext
}): Promise<Wallet[]> => {
  if (source.type === WalletType.External) return [source]

  const { domainAccount, cashWalletClientCapabilities } = ctx
  if (!domainAccount || !cashWalletClientCapabilities) return [source]
  if (domainAccount.id !== source.accountId) return [source]

  const presentation = await resolveCashWalletPresentationForAccount({
    account: domainAccount,
    client: cashWalletClientCapabilities,
  })
  if (presentation instanceof Error) throw mapError(presentation)

  return cashWalletHistoryWalletsForPresentation({
    wallets: [source],
    presentation,
  })
}
