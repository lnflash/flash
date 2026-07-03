import { getMe, gql, gqlOk, login } from "../client"
import { SMOKE } from "../config"

// UAT: AUTH-01/02 (session works across requests), AUTH-03 (usernames),
//      AUTH-04 (re-login preserves account state)
describe("Phase 0: account + session", () => {
  let tokenA: string
  let tokenB: string

  it("AUTH-01/02: both test accounts can log in with phone code", async () => {
    tokenA = await login(SMOKE.phoneA, SMOKE.code)
    tokenB = await login(SMOKE.phoneB, SMOKE.code)
    expect(tokenA).toBeTruthy()
    expect(tokenB).toBeTruthy()
  })

  it("AUTH-01: session token stays valid across repeated requests", async () => {
    const first = await getMe(tokenA)
    const second = await getMe(tokenA)
    expect(second.id).toBe(first.id)
    expect(second.defaultAccount.id).toBe(first.defaultAccount.id)
  })

  it("AUTH-03: usernames can be set (or already exist) and resolve to a wallet", async () => {
    const setUsername = async (token: string, username: string): Promise<string> => {
      const me = await getMe(token)
      if (me.username) return me.username // persistent env: keep existing
      const res = await gql<{
        userUpdateUsername: {
          errors: Array<{ message: string }>
          user: { username: string | null } | null
        }
      }>(
        `mutation smokeSetUsername($input: UserUpdateUsernameInput!) {
          userUpdateUsername(input: $input) {
            errors { message }
            user { username }
          }
        }`,
        { input: { username } },
        token,
      )
      // The mutation must not error; some environments return the updated
      // user immediately, others (deprecated resolver) return null — fall back
      // to the requested value and verify persistence via resolution below.
      expect(res.data?.userUpdateUsername.errors ?? []).toEqual([])
      return res.data?.userUpdateUsername.user?.username ?? username
    }

    const usernameA = await setUsername(tokenA, SMOKE.usernameA)
    const usernameB = await setUsername(tokenB, SMOKE.usernameB)
    expect(usernameA).not.toBe(usernameB)

    // Recipient resolution — the same lookup Send-by-username uses. Only
    // meaningful once usernames actually persist (full backend); the mock
    // accepts the mutation but does not persist the handle.
    if (!SMOKE.backendFull) return
    const resolved = await gqlOk<{ accountDefaultWallet: { id: string } }>(
      `query smokeResolve($username: Username!) {
        accountDefaultWallet(username: $username) { id }
      }`,
      { username: usernameB },
      tokenA,
    )
    expect(resolved.accountDefaultWallet.id).toBeTruthy()
  })

  it("AUTH-04: re-login returns a fresh token for the same account", async () => {
    const before = await getMe(tokenA)
    const fresh = await login(SMOKE.phoneA, SMOKE.code)
    const after = await getMe(fresh)
    expect(after.defaultAccount.id).toBe(before.defaultAccount.id)
    expect(after.defaultAccount.wallets.map((w) => w.id).sort()).toEqual(
      before.defaultAccount.wallets.map((w) => w.id).sort(),
    )
  })
})
