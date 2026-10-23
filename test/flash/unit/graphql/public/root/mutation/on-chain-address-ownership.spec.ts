const mockFindWallet = jest.fn()
const mockFindAccount = jest.fn()
const mockGenerateAddress = jest.fn()

jest.mock("@services/mongoose", () => ({
  WalletsRepository: () => ({
    findById: (...args: unknown[]) => mockFindWallet(...args),
  }),
  AccountsRepository: () => ({
    findById: (...args: unknown[]) => mockFindAccount(...args),
  }),
}))
jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    generateBitcoinAddress: (...args: unknown[]) => mockGenerateAddress(...args),
  },
}))

import { address, networks } from "bitcoinjs-lib"

import { createOwnedOnChainAddress } from "@app/wallets/create-owned-on-chain-address"
import { NETWORK } from "@config"
import { InvalidWalletForAccountError } from "@domain/accounts"
import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"
import OnChainAddressCreateMutation from "@graphql/public/root/mutation/on-chain-address-create"
import OnChainAddressCurrentMutation from "@graphql/public/root/mutation/on-chain-address-current"
import { UnexpectedIbexResponse } from "@services/ibex/errors"

const accountId = "owner-account" as AccountId
const walletId = "11111111-1111-4111-8111-111111111111" as WalletId
const ownedWallet = {
  id: walletId,
  accountId,
  type: WalletType.Checking,
  currency: WalletCurrency.Usdt,
}
const network =
  NETWORK === "mainnet"
    ? networks.bitcoin
    : NETWORK === "regtest"
      ? networks.regtest
      : networks.testnet
const ownedAddress = address.toBech32(Buffer.alloc(20, 1), 0, network.bech32)
const wrongNetworkAddress = address.toBech32(
  Buffer.alloc(20, 1),
  0,
  NETWORK === "mainnet" ? networks.testnet.bech32 : networks.bitcoin.bech32,
)

type Result = { errors: { message: string }[]; address?: string }
type Mutation = {
  resolve: (
    source: null,
    args: { input: { walletId: WalletId } },
    context: GraphQLPublicContextAuth,
    info: never,
  ) => Promise<Result>
}
const mutations = [OnChainAddressCreateMutation, OnChainAddressCurrentMutation]
const resolve = (mutation: (typeof mutations)[number], owner?: string) =>
  (mutation as unknown as Mutation).resolve(
    null,
    { input: { walletId } },
    { domainAccount: owner ? { id: owner } : undefined } as GraphQLPublicContextAuth,
    {} as never,
  )

beforeEach(() => {
  jest.clearAllMocks()
  mockFindWallet.mockResolvedValue(ownedWallet)
  mockFindAccount.mockResolvedValue({ id: accountId, status: "active" })
  mockGenerateAddress.mockResolvedValue({ address: ownedAddress })
})

describe.each(mutations)("on-chain receive resolver %#", (mutation) => {
  it("requires a current authenticated owner before reading a wallet", async () => {
    const result = await resolve(mutation)
    expect(result.errors).toHaveLength(1)
    expect(mockFindWallet).not.toHaveBeenCalled()
    expect(mockGenerateAddress).not.toHaveBeenCalled()
  })

  it("refuses a foreign wallet without creating a provider address", async () => {
    const result = await resolve(mutation, "other-owner")
    expect(result.errors).toHaveLength(1)
    expect(mockGenerateAddress).not.toHaveBeenCalled()
  })

  it("creates only an address for an active owned cash checking wallet", async () => {
    const result = await resolve(mutation, accountId)
    expect(result).toMatchObject({ errors: [], address: ownedAddress })
    expect(mockGenerateAddress).toHaveBeenCalledTimes(1)
    expect(mockGenerateAddress).toHaveBeenCalledWith(walletId)
  })

  it("does not expose a wrong-chain address from the provider", async () => {
    mockGenerateAddress.mockResolvedValue({ address: wrongNetworkAddress })
    const result = await resolve(mutation, accountId)
    expect(result.errors).toHaveLength(1)
    expect(result.address).toBeUndefined()
  })
})

describe("owned on-chain receive boundary", () => {
  it.each([
    { ...ownedWallet, accountId: "foreign" },
    { ...ownedWallet, type: WalletType.External },
    { ...ownedWallet, currency: WalletCurrency.Btc },
  ])(
    "rejects non-owned or non-cash checking wallet before provider call",
    async (wallet) => {
      mockFindWallet.mockResolvedValue(wallet)
      expect(await createOwnedOnChainAddress({ accountId, walletId })).toBeInstanceOf(
        InvalidWalletForAccountError,
      )
      expect(mockGenerateAddress).not.toHaveBeenCalled()
    },
  )

  it("refuses an inactive owner and invalid provider checksum", async () => {
    mockFindAccount.mockResolvedValue({ id: accountId, status: "locked" })
    expect(await createOwnedOnChainAddress({ accountId, walletId })).toBeInstanceOf(Error)
    expect(mockGenerateAddress).not.toHaveBeenCalled()

    mockFindAccount.mockResolvedValue({ id: accountId, status: "active" })
    mockGenerateAddress.mockResolvedValue({ address: `${ownedAddress.slice(0, -1)}q` })
    expect(await createOwnedOnChainAddress({ accountId, walletId })).toBeInstanceOf(
      UnexpectedIbexResponse,
    )
  })

  it("permits an owned USD checking wallet", async () => {
    mockFindWallet.mockResolvedValue({ ...ownedWallet, currency: WalletCurrency.Usd })
    expect(await createOwnedOnChainAddress({ accountId, walletId })).toBe(ownedAddress)
    expect(mockGenerateAddress).toHaveBeenCalledWith(walletId)
  })
})
