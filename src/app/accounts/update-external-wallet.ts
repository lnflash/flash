import { WalletCurrency } from "@domain/shared"
import { checkedToLunurl } from "@domain/wallets"
import { WalletsRepository } from "@services/mongoose"

export const updateExternalWallet = async ({ accountId, lnurlp }: { accountId: AccountId, lnurlp: string }): Promise<Wallet | ApplicationError> => {

    const checkedLnurl = checkedToLunurl(lnurlp)

    if (checkedLnurl instanceof Error) return checkedLnurl


    return WalletsRepository().upsertExternal({ accountId, currency: WalletCurrency.Btc, lnurlp: checkedLnurl })

}