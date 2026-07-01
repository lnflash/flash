jest.mock("@services/ibex/webhook-server/middleware", () => ({
  authenticate: jest.fn((_req, _res, next) => next()),
  logRequest: jest.fn((_req, _res, next) => next()),
}))

jest.mock("@services/mongoose/accounts", () => ({
  AccountsRepository: jest.fn(),
}))

jest.mock("@services/mongoose/ibex-crypto-receive-log", () => ({
  createIbexCryptoReceive: jest.fn(),
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

jest.mock("@services/bridge/reconciliation", () => ({
  reconcileByTxHash: jest.fn().mockResolvedValue({ status: "matched" }),
}))

jest.mock("@app/bridge/send-deposit-notification", () => ({
  sendBridgeDepositNotificationBestEffort: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@services/frappe/BridgeTransferRequestWriter", () => ({
  writeIbexCryptoReceiveRequest: jest.fn(),
}))

jest.mock("@services/alerts/ibex-bridge-movement", () => ({
  alertIbexCryptoReceiveFailure: jest.fn(),
  alertIbexReconciliationFailed: jest.fn(),
}))

import { cryptoReceiveHandler } from "@services/ibex/webhook-server/routes/crypto-receive"
import { AccountsRepository } from "@services/mongoose/accounts"
import { createIbexCryptoReceive } from "@services/mongoose/ibex-crypto-receive-log"
import { listWalletsByAccountId } from "@app/wallets"
import { LockService } from "@services/lock"
import { WalletCurrency } from "@domain/shared"
import { writeIbexCryptoReceiveRequest } from "@services/frappe/BridgeTransferRequestWriter"
import { alertIbexCryptoReceiveFailure } from "@services/alerts/ibex-bridge-movement"

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
      lockOnChainTxHash: jest.fn((_hash, fn) => fn()),
    })
    ;(AccountsRepository as jest.Mock).mockReturnValue({
      findByBridgeEthereumAddress: jest.fn().mockResolvedValue({ id: ACCOUNT_ID }),
    })
    ;(createIbexCryptoReceive as jest.Mock).mockResolvedValue({ id: "log-001" })
    ;(listWalletsByAccountId as jest.Mock).mockResolvedValue([
      { id: WALLET_ID, currency: WalletCurrency.Usdt },
    ])
    ;(writeIbexCryptoReceiveRequest as jest.Mock).mockResolvedValue(true)
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
    expect(createIbexCryptoReceive).toHaveBeenCalledWith(
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

  it("writes an ERPNext audit row after resolving the account and USDT wallet", async () => {
    const res = makeResponse()

    await cryptoReceiveHandler(
      {
        body: {
          tx_hash: TX_HASH,
          address: ADDRESS,
          amount: "12.345678",
          currency: "USDT",
          network: "ethereum",
        },
      } as never,
      res as never,
    )

    expect(writeIbexCryptoReceiveRequest).toHaveBeenCalledWith({
      txHash: TX_HASH,
      address: ADDRESS,
      amount: "12.345678",
      currency: "USDT",
      network: "Ethereum",
      accountId: ACCOUNT_ID,
      walletId: WALLET_ID,
      rawPayload: {
        tx_hash: TX_HASH,
        address: ADDRESS,
        amount: "12.345678",
        currency: "USDT",
        network: "ethereum",
      },
    })
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it("returns 500 when the ERPNext audit write fails", async () => {
    ;(writeIbexCryptoReceiveRequest as jest.Mock).mockResolvedValue(
      new Error("erpnext timeout"),
    )
    const res = makeResponse()

    await cryptoReceiveHandler(
      {
        body: {
          tx_hash: TX_HASH,
          address: ADDRESS,
          amount: "12.345678",
          currency: "USDT",
          network: "ethereum",
        },
      } as never,
      res as never,
    )

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: "erpnext_audit_failed" })
    expect(alertIbexCryptoReceiveFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        txHash: TX_HASH,
        code: "erpnext_audit_failed",
        title: "IBEX crypto receive ERPNext audit write failed",
      }),
    )
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

    expect(LockService().lockOnChainTxHash).not.toHaveBeenCalled()
    expect(createIbexCryptoReceive).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid payload" })
  })
})
