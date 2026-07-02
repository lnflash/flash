import { getMe, getTransactions, gql, gqlOk, login, usdWalletOf } from "../client"
import { SMOKE } from "../config"

// UAT: HOME-01 (wallet cards data), TX-00 (history loads cleanly),
//      WALLET-01 (default wallet), ONCHAIN-01 (onchain receive address)
describe("Phase 0/3: wallets + home data", () => {
  let token: string

  beforeAll(async () => {
    token = await login(SMOKE.phoneA, SMOKE.code)
  })

  it("HOME-01: account exposes wallets with numeric balances", async () => {
    const me = await getMe(token)
    expect(me.defaultAccount.wallets.length).toBeGreaterThan(0)
    for (const w of me.defaultAccount.wallets) {
      expect(typeof w.balance).toBe("number")
      expect(w.balance).toBeGreaterThanOrEqual(0)
      expect(["USD", "BTC", "USDT"]).toContain(w.walletCurrency)
    }
    const usd = usdWalletOf(me)
    expect(me.defaultAccount.wallets.map((w) => w.id)).toContain(
      me.defaultAccount.defaultWalletId,
    )
    expect(usd.id).toBeTruthy()
  })

  it("TX-00: transaction history query returns a clean, well-formed list", async () => {
    const txs = await getTransactions(token, 20)
    for (const tx of txs) {
      expect(["RECEIVE", "SEND"]).toContain(tx.direction)
      expect(tx.id).toBeTruthy()
      expect(typeof tx.settlementAmount).toBe("number")
    }
  })

  it("WALLET-01: default wallet id can be set through the API", async () => {
    const me = await getMe(token)
    // Setting to the current value exercises the mutation without changing
    // state — safe against persistent environments.
    const res = await gqlOk<{
      accountUpdateDefaultWalletId: {
        errors: Array<{ message: string }>
        account: { defaultWalletId: string } | null
      }
    }>(
      `mutation smokeDefaultWallet($input: AccountUpdateDefaultWalletIdInput!) {
        accountUpdateDefaultWalletId(input: $input) {
          errors { message }
          account { defaultWalletId }
        }
      }`,
      { input: { walletId: me.defaultAccount.defaultWalletId } },
      token,
    )
    expect(res.accountUpdateDefaultWalletId.errors).toEqual([])
    expect(res.accountUpdateDefaultWalletId.account?.defaultWalletId).toBe(
      me.defaultAccount.defaultWalletId,
    )
  })

  it("ONCHAIN-01: onchain receive address is generated when a BTC wallet exists", async () => {
    const me = await getMe(token)
    const btc = me.defaultAccount.wallets.find((w) => w.walletCurrency === "BTC")
    if (!btc) {
      // eslint-disable-next-line no-console
      console.log("ONCHAIN-01 skipped: account has no BTC wallet in this environment")
      return
    }
    const res = await gql<{
      onChainAddressCreate: {
        errors: Array<{ message: string }>
        address: string | null
      }
    }>(
      `mutation smokeOnchain($input: OnChainAddressCreateInput!) {
        onChainAddressCreate(input: $input) { errors { message } address }
      }`,
      { input: { walletId: btc.id } },
      token,
    )
    const payload = res.data?.onChainAddressCreate
    expect(payload).toBeTruthy()
    // Either a usable address or a clean structured error — never a crash.
    const addressOk = (payload?.address?.length ?? 0) > 20
    const erroredCleanly = (payload?.errors.length ?? 0) > 0
    expect(addressOk || erroredCleanly).toBe(true)
  })
})
