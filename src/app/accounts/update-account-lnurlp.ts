
import { UnexpectedIbexResponse } from "@services/ibex/errors"
import ibex from "@services/ibex"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"

export const setLnurlp = async ({
    accountId,
    lnurl,
    walletId
}: { accountId: AccountId, lnurl: string, walletId?: WalletId }): Promise<Account | ApplicationError> => {

    const account = await AccountsRepository().findById(accountId);
    if (account instanceof Error) return account

    const targetWalletId = walletId || account.defaultWalletId;

    const updatedAccount = await updateAccountLnurlps({ account, lnurl, walletId: targetWalletId })
    if (updatedAccount instanceof Error) return updatedAccount

    // Dual-write to wallet
    const wallet = await WalletsRepository().findById(targetWalletId)
    if (!(wallet instanceof Error)) {
        await WalletsRepository().update({ ...wallet, lnurlp: lnurl as Lnurl })
    }

    return updatedAccount
}

export const generateLnurlp = async ({
    accountId,
    walletId
}: { accountId: AccountId, walletId: WalletId }): Promise<Account | ApplicationError> => {

    const account = await AccountsRepository().findById(accountId);
    if (account instanceof Error) return account

    const wallet = await WalletsRepository().findById(walletId)
    if (wallet instanceof Error) return wallet

    const lnurlpResp = await ibex.client.createLnurlPay({
        accountId: walletId as string,
    })

    if (lnurlpResp instanceof Error) return lnurlpResp
    if (!lnurlpResp.lnurl) return new UnexpectedIbexResponse("Failed to create lnurlp")

    const lnurl = lnurlpResp.lnurl

    const updatedAccount = await updateAccountLnurlps({ account, lnurl, walletId })
    if (updatedAccount instanceof Error) return updatedAccount

    // Dual-write to wallet
    await WalletsRepository().update({ ...wallet, lnurlp: lnurl as Lnurl })

    return updatedAccount
}

const updateAccountLnurlps = async ({
    account,
    lnurl,
    walletId
}: { account: Account, lnurl: string, walletId: WalletId }): Promise<Account | ApplicationError> => {
    const lnurlps = account.lnurlps || []

    const updatedLnurlps = lnurlps.map((item) => ({
        lnurlp: item.lnurlp,
        active: false,
        walletId: item.walletId
    }))

    updatedLnurlps.push({
        lnurlp: lnurl,
        active: true,
        walletId
    })

    account.lnurlps = updatedLnurlps

    return AccountsRepository().update(account)
}

// Keep updateLnurlp for backward compatibility if needed, or we can just remove it if we update all callers
export const updateLnurlp = async ({
    accountId,
    lnurlp,
    walletId
}: { accountId: AccountId, lnurlp?: string, walletId?: WalletId }): Promise<Account | ApplicationError> => {
    if (lnurlp) {
        return setLnurlp({ accountId, lnurl: lnurlp, walletId })
    }
    
    const account = await AccountsRepository().findById(accountId)
    if (account instanceof Error) return account
    const targetWalletId = walletId || account.defaultWalletId
    
    return generateLnurlp({ accountId, walletId: targetWalletId })
}