import { execFileSync } from "child_process"

import { SMOKE } from "./config"

type GqlResponse<T = Record<string, unknown>> = {
  data?: T
  errors?: Array<{ message: string; extensions?: { code?: string } }>
}

export const gql = async <T = Record<string, unknown>>(
  query: string,
  variables: Record<string, unknown> = {},
  token?: string,
): Promise<GqlResponse<T>> => {
  const res = await fetch(SMOKE.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok && res.status !== 400) {
    throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`)
  }
  return (await res.json()) as GqlResponse<T>
}

// Throws with the full error list when the response has transport-level errors.
export const gqlOk = async <T = Record<string, unknown>>(
  query: string,
  variables: Record<string, unknown> = {},
  token?: string,
): Promise<T> => {
  const res = await gql<T>(query, variables, token)
  if (res.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(res.errors)}`)
  }
  if (!res.data) throw new Error("GraphQL response had no data")
  return res.data
}

// True when the response carries a schema-validation error for `field` — i.e.
// the target backend predates that field. Lets version-dependent specs skip
// gracefully instead of failing against an older deployment.
export const isUnknownFieldError = (
  errors:
    | Array<{ message: string; extensions?: { code?: string; field?: string } }>
    | undefined,
  field: string,
): boolean =>
  (errors ?? []).some(
    (e) =>
      // Apollo Server validation (direct API endpoints)
      (e.extensions?.code === "GRAPHQL_VALIDATION_FAILED" && e.message.includes(field)) ||
      // galoy custom validation (e.g. quickstart's stale supergraph route)
      (e.extensions?.code === "INVALID_FIELD" && e.extensions?.field === field),
  )

export const login = async (phone: string, code: string): Promise<string> => {
  const data = await gqlOk<{
    userLogin: { authToken: string | null; errors: Array<{ message: string }> }
  }>(
    `mutation smokeLogin($input: UserLoginInput!) {
      userLogin(input: $input) { authToken errors { message } }
    }`,
    { input: { phone, code } },
  )
  if (!data.userLogin.authToken) {
    throw new Error(`login failed for ${phone}: ${JSON.stringify(data.userLogin.errors)}`)
  }
  return data.userLogin.authToken
}

export type WalletInfo = {
  id: string
  walletCurrency: string
}

export type MeInfo = {
  id: string
  username: string | null
  defaultAccount: {
    id: string
    defaultWalletId: string
    wallets: WalletInfo[]
  }
}

// Identity + wallet shape only. Deliberately omits `balance`: it resolves
// through IBEX, which the quickstart stack mocks without a balance path, so
// selecting it would poison every identity/session assertion. Balance is a
// separate best-effort fetch (getBalance) used only by full-backend specs.
export const getMe = async (token: string): Promise<MeInfo> => {
  const data = await gqlOk<{ me: MeInfo }>(
    `query smokeMe {
      me {
        id
        username
        defaultAccount {
          id
          defaultWalletId
          wallets { id walletCurrency }
        }
      }
    }`,
    {},
    token,
  )
  return data.me
}

// Best-effort: returns null when the environment can't resolve balances
// (e.g. IBEX-mock quickstart) instead of throwing.
export const getBalance = async (
  token: string,
  walletId: string,
): Promise<number | null> => {
  const res = await gql<{
    me: { defaultAccount: { wallets: Array<{ id: string; balance: number }> } }
  }>(
    `query smokeBalance {
      me { defaultAccount { wallets { id balance } } }
    }`,
    {},
    token,
  )
  const wallet = res.data?.me.defaultAccount.wallets.find((w) => w.id === walletId)
  return typeof wallet?.balance === "number" ? wallet.balance : null
}

export type TxNode = {
  id: string
  direction: string
  status: string
  memo: string | null
  settlementAmount: number
  settlementCurrency: string
  createdAt: number
}

export const getTransactions = async (token: string, first = 10): Promise<TxNode[]> => {
  const data = await gqlOk<{
    me: { defaultAccount: { transactions: { edges: Array<{ node: TxNode }> } | null } }
  }>(
    `query smokeTxs($first: Int) {
      me {
        defaultAccount {
          transactions(first: $first) {
            edges {
              node {
                id direction status memo settlementAmount settlementCurrency createdAt
              }
            }
          }
        }
      }
    }`,
    { first },
    token,
  )
  return (data.me.defaultAccount.transactions?.edges ?? []).map((e) => e.node)
}

export const usdWalletOf = (me: MeInfo): WalletInfo => {
  const w = me.defaultAccount.wallets.find((x) => x.walletCurrency === "USD")
  if (!w) throw new Error(`no USD wallet on account ${me.defaultAccount.id}`)
  return w
}

// Docker-exec helpers against the quickstart containers (local/CI only).
export const dockerExec = (container: string, args: string[]): string =>
  execFileSync("docker", ["exec", `${SMOKE.composeProject}-${container}-1`, ...args], {
    encoding: "utf8",
    timeout: 30000,
  })

export const lndOutside = (args: string[]): string =>
  dockerExec("lnd-outside-1", [
    "lncli",
    "--macaroonpath",
    "/root/.lnd/data/chain/bitcoin/regtest/admin.macaroon",
    "--tlscertpath",
    "/root/.lnd/tls.cert",
    ...args,
  ])

export const retry = async <T>(
  fn: () => Promise<T>,
  check: (v: T) => boolean,
  attempts = 30,
  delayMs = 1000,
): Promise<T> => {
  let last: T = await fn()
  for (let i = 0; i < attempts; i++) {
    if (check(last)) return last
    await new Promise((r) => setTimeout(r, delayMs))
    last = await fn()
  }
  return last
}
