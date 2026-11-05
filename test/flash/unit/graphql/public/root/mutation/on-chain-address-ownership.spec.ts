const mockFindWallet = jest.fn()
const mockFindAccount = jest.fn()
const mockGenerateAddress = jest.fn()
const mockRouteCashWallet = jest.fn()

jest.mock("@app/cash-wallet-cutover", () => ({
  resolveCashWalletMutationWalletIdForAccount: (args: unknown) =>
    mockRouteCashWallet(args),
}))

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
const settlementWalletId = "22222222-2222-4222-8222-222222222222" as WalletId
const client = {
  cashWalletPresentation: "usdt" as const,
  hasUsdtCashWalletSupport: true,
}
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
    {
      domainAccount: owner ? { id: owner } : undefined,
      cashWalletClientCapabilities: client,
    } as GraphQLPublicContextAuth,
    {} as never,
  )

beforeEach(() => {
  jest.clearAllMocks()
  mockFindWallet.mockResolvedValue(ownedWallet)
  mockFindAccount.mockResolvedValue({ id: accountId, status: "active" })
  mockGenerateAddress.mockResolvedValue({ address: ownedAddress })
  mockRouteCashWallet.mockImplementation(
    async ({ walletId }: { walletId: WalletId }) => walletId,
  )
})

describe.each(mutations)("on-chain receive resolver %#", (mutation) => {
  it("requires a current authenticated owner before reading a wallet", async () => {
    const result = await resolve(mutation)
    expect(result.errors).toHaveLength(1)
    expect(mockFindWallet).not.toHaveBeenCalled()
    expect(mockRouteCashWallet).not.toHaveBeenCalled()
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

  it("routes an owned legacy USD alias to the active USDT IBEX account", async () => {
    mockRouteCashWallet.mockResolvedValue(settlementWalletId)
    mockFindWallet.mockImplementation(async (id: WalletId) =>
      id === walletId
        ? { ...ownedWallet, currency: WalletCurrency.Usd }
        : { ...ownedWallet, id: settlementWalletId },
    )
    const result = await resolve(mutation, accountId)
    expect(result).toMatchObject({ errors: [], address: ownedAddress })
    expect(mockRouteCashWallet).toHaveBeenCalledWith({
      account: expect.objectContaining({ id: accountId }),
      walletId,
      client,
    })
    expect(mockFindWallet).toHaveBeenCalledWith(settlementWalletId)
    expect(mockGenerateAddress).toHaveBeenCalledWith(settlementWalletId)
  })

  it("refuses a cash alias that resolves to a foreign wallet", async () => {
    mockRouteCashWallet.mockResolvedValue(settlementWalletId)
    mockFindWallet.mockImplementation(async (id: WalletId) =>
      id === walletId
        ? { ...ownedWallet, currency: WalletCurrency.Usd }
        : { ...ownedWallet, id: settlementWalletId, accountId: "foreign" },
    )
    const result = await resolve(mutation, accountId)
    expect(result.errors).toHaveLength(1)
    expect(mockGenerateAddress).not.toHaveBeenCalled()
  })

  it.each([
    { type: WalletType.External, currency: WalletCurrency.Usdt },
    { type: WalletType.Checking, currency: WalletCurrency.Usd },
  ])("refuses a routed wallet outside USDT checking", async (selection) => {
    mockRouteCashWallet.mockResolvedValue(settlementWalletId)
    mockFindWallet.mockImplementation(async (id: WalletId) =>
      id === walletId
        ? { ...ownedWallet, currency: WalletCurrency.Usd }
        : { ...ownedWallet, id: settlementWalletId, ...selection },
    )
    const result = await resolve(mutation, accountId)
    expect(result.errors).toHaveLength(1)
    expect(mockGenerateAddress).not.toHaveBeenCalled()
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
      expect(
        await createOwnedOnChainAddress({ accountId, walletId, client }),
      ).toBeInstanceOf(InvalidWalletForAccountError)
      expect(mockRouteCashWallet).not.toHaveBeenCalled()
      expect(mockGenerateAddress).not.toHaveBeenCalled()
    },
  )

  it("refuses an inactive owner and invalid provider checksum", async () => {
    mockFindAccount.mockResolvedValue({ id: accountId, status: "locked" })
    expect(
      await createOwnedOnChainAddress({ accountId, walletId, client }),
    ).toBeInstanceOf(Error)
    expect(mockRouteCashWallet).not.toHaveBeenCalled()
    expect(mockGenerateAddress).not.toHaveBeenCalled()

    mockFindAccount.mockResolvedValue({ id: accountId, status: "active" })
    mockGenerateAddress.mockResolvedValue({ address: `${ownedAddress.slice(0, -1)}q` })
    expect(
      await createOwnedOnChainAddress({ accountId, walletId, client }),
    ).toBeInstanceOf(UnexpectedIbexResponse)
  })

  it("permits an owned USD checking wallet", async () => {
    mockFindWallet.mockResolvedValue({ ...ownedWallet, currency: WalletCurrency.Usd })
    expect(await createOwnedOnChainAddress({ accountId, walletId, client })).toBe(
      ownedAddress,
    )
    expect(mockGenerateAddress).toHaveBeenCalledWith(walletId)
  })
})
