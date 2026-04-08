
import { UnexpectedIbexResponse } from "@services/ibex/errors"
import ibex from "@services/ibex"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"

export const updateLnurlp = async ({
    accountId,
    lnurlp,
    walletId
}: { accountId: AccountId, lnurlp?: string, walletId?: WalletId }): Promise<Account | ApplicationError> => {

    let lnurlpToUpdate: string
    const account = await AccountsRepository().findById(accountId);

    if (account instanceof Error) return account


    if (lnurlp) {
        lnurlpToUpdate = lnurlp
    } else {
        const targetWalletId = walletId || account.defaultWalletId;

        const wallet = await WalletsRepository().findById(targetWalletId)

        if (wallet instanceof Error) return wallet

        const lnurlpResp = await ibex.client.createLnurlPay({
            accountId: targetWalletId as string,
        })

        if (lnurlpResp instanceof Error) return lnurlpResp
        if (!lnurlpResp.lnurl) return new UnexpectedIbexResponse("Failed to create lnurlp")

        lnurlpToUpdate = lnurlpResp.lnurl
    }

    const lnurlps = account.lnurlps || []
    
    const updatedLnurlps = lnurlps.map((item) => ({
        lnurlp: item.lnurlp,
        active: false,
        walletId: item.walletId
    }))

    updatedLnurlps.push({
        lnurlp: lnurlpToUpdate,
        active: true,
        walletId: walletId
    })

    account.lnurlps = updatedLnurlps

    return AccountsRepository().update(account)
}