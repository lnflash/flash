import axios from "axios"

type Args = {
  url: string
  token: string
  first: number
  amount: number
  paymentRequest?: string
  address?: string
  strictFixtures: boolean
}

type GraphQLResponse<T> = {
  data?: T
  errors?: { message: string; path?: string[] }[]
}

type Wallet = {
  __typename: string
  id: string
  walletCurrency: string
  balance?: number | null
  transactions?: {
    edges?: {
      node?: {
        id: string
        settlementCurrency: string
        settlementAmount: number
        settlementDisplayAmount: string
        settlementDisplayCurrency: string
        settlementDisplayFee: string
        settlementFee: number
        settlementPrice: {
          base: number
          offset: number
        }
        initiationVia: { __typename: string }
        settlementVia: { __typename: string }
      }
    }[]
  } | null
}

type CheckResult = {
  name: string
  status: "PASS" | "FAIL" | "SKIP"
  details?: string
}

const usage = `
Usage:
  yarn ts-node --transpile-only -r tsconfig-paths/register dev/bin/eng-297-graphql-smoke.ts \\
    --url http://localhost:4002/graphql \\
    --token "$AUTH_TOKEN" \\
    [--payment-request lnbc...] \\
    [--address bc1...] \\
    [--amount 100]

Required:
  --url              GraphQL endpoint
  --token            Bearer token for a test account

Optional fixtures:
  --payment-request  Bolt11 invoice for lnUsdInvoiceFeeProbe checks
  --address          On-chain address for onChainUsdTxFee checks
  --amount           Fractional cent amount for no-amount/on-chain checks. Default: 100
  --first            Transaction page size per wallet. Default: 10
  --strict-fixtures  Fail instead of skip checks that require optional fixtures
`

const parseArgs = (argv: string[]): Args => {
  const parsed: Record<string, string | boolean> = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") {
      console.log(usage.trim())
      process.exit(0)
    }
    if (!arg.startsWith("--")) continue

    const key = arg.slice(2)
    if (key === "strict-fixtures") {
      parsed[key] = true
      continue
    }

    const value = argv[i + 1]
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`)
    }
    parsed[key] = value
    i++
  }

  const url = (parsed.url || process.env.GRAPHQL_URL) as string | undefined
  const token = (parsed.token || process.env.AUTH_TOKEN || process.env.TOKEN) as
    | string
    | undefined

  if (!url) throw new Error("Missing --url or GRAPHQL_URL")
  if (!token) throw new Error("Missing --token, AUTH_TOKEN, or TOKEN")

  return {
    url,
    token,
    first: Number(parsed.first || 10),
    amount: Number(parsed.amount || 100),
    paymentRequest: (parsed["payment-request"] || parsed.paymentRequest) as
      | string
      | undefined,
    address: parsed.address as string | undefined,
    strictFixtures: Boolean(parsed["strict-fixtures"]),
  }
}

const results: CheckResult[] = []

const pass = (name: string, details?: string) => {
  results.push({ name, status: "PASS", details })
}

const fail = (name: string, details?: string) => {
  results.push({ name, status: "FAIL", details })
}

const skip = (name: string, details?: string) => {
  results.push({ name, status: "SKIP", details })
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const graphql = async <T>(
  args: Args,
  operationName: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> => {
  const resp = await axios.post<GraphQLResponse<T>>(
    args.url,
    { operationName, query, variables },
    {
      headers: {
        Authorization: `Bearer ${args.token}`,
        "Content-Type": "application/json",
      },
      validateStatus: () => true,
    },
  )

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`HTTP ${resp.status}: ${JSON.stringify(resp.data)}`)
  }

  if (resp.data.errors?.length) {
    throw new Error(JSON.stringify(resp.data.errors, null, 2))
  }

  if (!resp.data.data) throw new Error("Missing GraphQL data")
  return resp.data.data
}

const recordCheck = async (name: string, check: () => Promise<string | void>) => {
  try {
    const details = await check()
    pass(name, details || undefined)
  } catch (err) {
    fail(name, err instanceof Error ? err.message : `${err}`)
  }
}

const optionalCheck = async (
  args: Args,
  name: string,
  fixtureDescription: string,
  check: () => Promise<string | void>,
) => {
  if (args.strictFixtures) {
    await recordCheck(name, check)
    return
  }

  try {
    const details = await check()
    pass(name, details || undefined)
  } catch (err) {
    const message = err instanceof Error ? err.message : `${err}`
    if (message.includes("Missing fixture:")) {
      skip(name, fixtureDescription)
      return
    }
    fail(name, message)
  }
}

const walletSummary = (wallet: Wallet) =>
  `${wallet.__typename}/${wallet.walletCurrency}/${wallet.id}`

const getWallets = async (args: Args): Promise<Wallet[]> => {
  const data = await graphql<{
    me: {
      defaultAccount: {
        wallets: Wallet[]
      }
    } | null
  }>(
    args,
    "Eng297WalletsAndTransactions",
    `
      query Eng297WalletsAndTransactions($first: Int!) {
        me {
          defaultAccount {
            wallets {
              __typename
              ... on BTCWallet {
                id
                walletCurrency
                balance
                transactions(first: $first) { ...TransactionConnectionFields }
              }
              ... on UsdWallet {
                id
                walletCurrency
                usdBalance: balance
                isExternal
                transactions(first: $first) { ...TransactionConnectionFields }
              }
              ... on UsdtWallet {
                id
                walletCurrency
                usdtBalance: balance
                isExternal
                transactions(first: $first) { ...TransactionConnectionFields }
              }
            }
          }
        }
      }

      fragment TransactionConnectionFields on TransactionConnection {
        edges {
          node {
            id
            settlementCurrency
            settlementAmount
            settlementDisplayAmount
            settlementDisplayCurrency
            settlementDisplayFee
            settlementFee
            settlementPrice {
              base
              offset
            }
            initiationVia { __typename }
            settlementVia { __typename }
          }
        }
      }
    `,
    { first: args.first },
  )

  const defaultAccount = data.me?.defaultAccount
  assert(defaultAccount, "Missing me.defaultAccount")
  return defaultAccount.wallets
}

const requireWallet = (wallets: Wallet[], currency: string): Wallet => {
  const wallet = wallets.find((candidate) => candidate.walletCurrency === currency)
  assert(wallet, `Missing ${currency} wallet`)
  return wallet as Wallet
}

const assertNoTransactionShapeGaps = (wallet: Wallet) => {
  const transactions = wallet.transactions?.edges || []
  for (const edge of transactions) {
    const tx = edge.node
    if (!tx) {
      throw new Error(`${walletSummary(wallet)} has transaction edge without node`)
    }
    assert(tx.id, `${walletSummary(wallet)} transaction missing id`)
    assert(
      tx.settlementCurrency,
      `${walletSummary(wallet)} transaction ${tx.id} missing settlementCurrency`,
    )
    assert(
      tx.settlementDisplayCurrency,
      `${walletSummary(wallet)} transaction ${tx.id} missing settlementDisplayCurrency`,
    )
    assert(
      tx.settlementPrice,
      `${walletSummary(wallet)} transaction ${tx.id} missing settlementPrice`,
    )
    assert(
      tx.initiationVia?.__typename,
      `${walletSummary(wallet)} transaction ${tx.id} missing initiationVia.__typename`,
    )
    assert(
      tx.settlementVia?.__typename,
      `${walletSummary(wallet)} transaction ${tx.id} missing settlementVia.__typename`,
    )
  }
}

const runLnUsdInvoiceFeeProbe = async (args: Args, wallet: Wallet) => {
  if (!args.paymentRequest) throw new Error("Missing fixture: paymentRequest")

  const data = await graphql<{
    lnUsdInvoiceFeeProbe: {
      errors: { message: string }[]
      amount?: number
      invoiceAmount?: number
    }
  }>(
    args,
    "Eng297LnUsdInvoiceFeeProbe",
    `
      mutation Eng297LnUsdInvoiceFeeProbe($input: LnUsdInvoiceFeeProbeInput!) {
        lnUsdInvoiceFeeProbe(input: $input) {
          errors { message }
          amount
          invoiceAmount
        }
      }
    `,
    {
      input: {
        walletId: wallet.id,
        paymentRequest: args.paymentRequest,
      },
    },
  )

  const result = data.lnUsdInvoiceFeeProbe
  assert(
    result.errors.length === 0,
    `${walletSummary(wallet)} lnUsdInvoiceFeeProbe errors: ${JSON.stringify(result.errors)}`,
  )
  assert(result.amount !== undefined, `${walletSummary(wallet)} missing fee amount`)
  assert(
    result.invoiceAmount !== undefined,
    `${walletSummary(wallet)} missing invoiceAmount`,
  )
}

const runLnNoAmountUsdInvoiceFeeProbe = async (args: Args, wallet: Wallet) => {
  if (!args.paymentRequest) throw new Error("Missing fixture: paymentRequest")

  const data = await graphql<{
    lnNoAmountUsdInvoiceFeeProbe: {
      errors: { message: string }[]
      amount?: number
      invoiceAmount?: number
    }
  }>(
    args,
    "Eng297LnNoAmountUsdInvoiceFeeProbe",
    `
      mutation Eng297LnNoAmountUsdInvoiceFeeProbe($input: LnNoAmountUsdInvoiceFeeProbeInput!) {
        lnNoAmountUsdInvoiceFeeProbe(input: $input) {
          errors { message }
          amount
          invoiceAmount
        }
      }
    `,
    {
      input: {
        walletId: wallet.id,
        paymentRequest: args.paymentRequest,
        amount: args.amount,
      },
    },
  )

  const result = data.lnNoAmountUsdInvoiceFeeProbe
  assert(
    result.errors.length === 0,
    `${walletSummary(wallet)} lnNoAmountUsdInvoiceFeeProbe errors: ${JSON.stringify(result.errors)}`,
  )
  assert(result.amount !== undefined, `${walletSummary(wallet)} missing fee amount`)
  assert(
    result.invoiceAmount !== undefined,
    `${walletSummary(wallet)} missing invoiceAmount`,
  )
}

const runOnChainUsdTxFee = async (args: Args, wallet: Wallet) => {
  if (!args.address) throw new Error("Missing fixture: address")

  const data = await graphql<{
    onChainUsdTxFee: {
      amount: number
    }
  }>(
    args,
    "Eng297OnChainUsdTxFee",
    `
      query Eng297OnChainUsdTxFee(
        $walletId: WalletId!
        $address: OnChainAddress!
        $amount: FractionalCentAmount!
      ) {
        onChainUsdTxFee(walletId: $walletId, address: $address, amount: $amount) {
          amount
        }
      }
    `,
    {
      walletId: wallet.id,
      address: args.address,
      amount: args.amount,
    },
  )

  assert(
    data.onChainUsdTxFee.amount !== undefined,
    `${walletSummary(wallet)} missing onChainUsdTxFee amount`,
  )
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  let wallets: Wallet[] = []

  await recordCheck("wallet list includes USD and USDT wallets", async () => {
    wallets = await getWallets(args)
    const usdWallet = requireWallet(wallets, "USD")
    const usdtWallet = requireWallet(wallets, "USDT")
    return `${walletSummary(usdWallet)}, ${walletSummary(usdtWallet)}`
  })

  if (wallets.length > 0) {
    await recordCheck("wallet transaction shapes are render-safe", async () => {
      for (const wallet of wallets) assertNoTransactionShapeGaps(wallet)
      const counts = wallets.map(
        (wallet) => `${wallet.walletCurrency}:${wallet.transactions?.edges?.length || 0}`,
      )
      return counts.join(", ")
    })

    for (const currency of ["USD", "USDT"]) {
      const wallet = wallets.find((candidate) => candidate.walletCurrency === currency)
      if (!wallet) continue

      await optionalCheck(
        args,
        `${currency} lnUsdInvoiceFeeProbe`,
        "skipped; pass --payment-request to exercise Lightning fee probe",
        () => runLnUsdInvoiceFeeProbe(args, wallet),
      )

      await optionalCheck(
        args,
        `${currency} lnNoAmountUsdInvoiceFeeProbe`,
        "skipped; pass --payment-request to exercise no-amount Lightning fee probe",
        () => runLnNoAmountUsdInvoiceFeeProbe(args, wallet),
      )

      await optionalCheck(
        args,
        `${currency} onChainUsdTxFee`,
        "skipped; pass --address to exercise on-chain fee probe",
        () => runOnChainUsdTxFee(args, wallet),
      )
    }
  }

  for (const result of results) {
    const icon = result.status === "PASS" ? "✅" : result.status === "SKIP" ? "⏭️" : "❌"
    console.log(`${icon} ${result.status} ${result.name}`)
    if (result.details) console.log(`   ${result.details}`)
  }

  const failed = results.filter((result) => result.status === "FAIL")
  if (failed.length > 0) {
    console.error(`\n${failed.length} smoke check(s) failed`)
    process.exit(1)
  }

  console.log("\nENG-297 GraphQL smoke checks completed")
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
