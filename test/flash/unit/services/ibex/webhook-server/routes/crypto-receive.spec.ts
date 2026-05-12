jest.mock("@services/ibex/webhook-server/middleware", () => ({
  authenticate: jest.fn((_req, _res, next) => next()),
  logRequest: jest.fn((_req, _res, next) => next()),
}))

jest.mock("@services/mongoose/accounts", () => ({
  AccountsRepository: jest.fn(),
}))

jest.mock("@services/mongoose/ibex-crypto-receive-log", () => ({
  createIbexCryptoReceiveLog: jest.fn(),
}))

jest.mock("@app/wallets", () => ({
  listWalletsByAccountId: jest.fn(),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/lock", () => ({
  LockService: jest.fn(),
}))

import { cryptoReceiveHandler } from "@services/ibex/webhook-server/routes/crypto-receive"
import { AccountsRepository } from "@services/mongoose/accounts"
import { createIbexCryptoReceiveLog } from "@services/mongoose/ibex-crypto-receive-log"
import { listWalletsByAccountId } from "@app/wallets"
import { LockService } from "@services/lock"
import { WalletCurrency } from "@domain/shared"

const ACCOUNT_ID = "account-001" as AccountId
const WALLET_ID = "wallet-usdt-001" as WalletId
const ADDRESS = "0xabc123"
const TX_HASH = "tx-001"

const makeResponse = () => {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  }
  return res
}

describe("cryptoReceiveHandler", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(LockService as jest.Mock).mockReturnValue({
      lockPaymentHash: jest.fn((_hash, fn) => fn()),
    })
    ;(AccountsRepository as jest.Mock).mockReturnValue({
      findByBridgeEthereumAddress: jest.fn().mockResolvedValue({ id: ACCOUNT_ID }),
    })
    ;(createIbexCryptoReceiveLog as jest.Mock).mockResolvedValue({ id: "log-001" })
    ;(listWalletsByAccountId as jest.Mock).mockResolvedValue([
      { id: WALLET_ID, currency: WalletCurrency.Usdt },
    ])
  })

  it("accepts Ethereum USDT receive webhooks and normalizes persisted currency/network", async () => {
    const res = makeResponse()

    await cryptoReceiveHandler(
      {
        body: {
          tx_hash: TX_HASH,
          address: ADDRESS,
          amount: "12.345678",
          currency: "usdt",
          network: "Ethereum",
        },
      } as never,
      res as never,
    )

    expect(AccountsRepository().findByBridgeEthereumAddress).toHaveBeenCalledWith(ADDRESS)
    expect(createIbexCryptoReceiveLog).toHaveBeenCalledWith(
      expect.objectContaining({
        txHash: TX_HASH,
        address: ADDRESS,
        amount: "12.345678",
        currency: "USDT",
        network: "ethereum",
        accountId: ACCOUNT_ID,
      }),
    )
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ status: "success" })
  })

  it("rejects legacy Tron USDT receive webhooks for the ETH-USDT Cash Wallet path", async () => {
    const res = makeResponse()

    await cryptoReceiveHandler(
      {
        body: {
          tx_hash: TX_HASH,
          address: ADDRESS,
          amount: "12.345678",
          currency: "USDT",
          network: "tron",
        },
      } as never,
      res as never,
    )

    expect(LockService().lockPaymentHash).not.toHaveBeenCalled()
    expect(createIbexCryptoReceiveLog).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid payload" })
  })
})
