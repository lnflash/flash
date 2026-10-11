const mockFindByUsername = jest.fn()
const mockResolveCashWalletPresentationForAccount = jest.fn()

jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({
    findByUsername: (...a: unknown[]) => mockFindByUsername(...a),
  }),
}))
jest.mock("@app/cash-wallet-cutover", () => ({
  resolveCashWalletPresentationForAccount: (
    ...args: Parameters<typeof mockResolveCashWalletPresentationForAccount>
  ) => mockResolveCashWalletPresentationForAccount(...args),
}))

import { graphql, GraphQLObjectType, GraphQLSchema } from "graphql"

import AccountDefaultWalletQuery from "@graphql/public/root/query/account-default-wallet"

import { AccountStatus } from "@domain/accounts"
import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"

const wallet = {
  id: "wallet-1" as WalletId,
  accountId: "account-1" as AccountId,
  currency: WalletCurrency.Usd,
  type: WalletType.Checking,
  onChainAddressIdentifiers: [],
  onChainAddresses: () => [],
  lnurlp: "lnurlp-usd" as Lnurl,
} as unknown as Wallet

// Real schema over the real field definition, so the resolver, the status
// guard and mapError all run. A `buildSchema` over the committed SDL would use
// default resolvers and pass with the guard deleted.
const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: "Query",
    fields: {
      accountDefaultWallet: AccountDefaultWalletQuery as never,
    },
  }),
})

const queryWallet = () =>
  graphql({
    schema,
    source: '{ accountDefaultWallet(username: "alice") { id } }',
    contextValue: {},
  })

const presentation = { defaultWalletId: wallet.id, wallets: [wallet] }

beforeEach(() => {
  jest.clearAllMocks()
  mockResolveCashWalletPresentationForAccount.mockResolvedValue(presentation)
})

describe("accountDefaultWallet — inactive accounts", () => {
  it("returns the default wallet for an active account", async () => {
    mockFindByUsername.mockResolvedValue({
      id: "account-1",
      status: AccountStatus.Active,
    })

    const res = await queryWallet()

    expect(res.errors).toBeUndefined()
    expect(res.data?.accountDefaultWallet).toEqual({ id: wallet.id })
  })

  // Lightning Address resolution starts here: whatever this query returns is
  // what a sending wallet then posts an invoice against. An inactive account
  // has to fail at this hop, not after the money is already in flight.
  it.each([
    ["new", AccountStatus.New],
    ["pending", AccountStatus.Pending],
    ["locked", AccountStatus.Locked],
    ["closed", AccountStatus.Closed],
  ])("refuses a %s account before resolving the wallet", async (_name, status) => {
    mockFindByUsername.mockResolvedValue({ id: "account-1", status })

    const res = await queryWallet()

    expect(res.data?.accountDefaultWallet ?? null).toBeNull()
    expect(res.errors?.[0].message).toMatch(/Account is inactive/)
    expect(mockResolveCashWalletPresentationForAccount).not.toHaveBeenCalled()
  })
})
