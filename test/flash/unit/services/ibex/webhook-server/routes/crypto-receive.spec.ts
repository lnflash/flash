jest.mock("@services/ibex/webhook-server/middleware", () => ({
  authenticate: jest.fn((_req, _res, next) => next()),
  logRequest: jest.fn((_req, _res, next) => next()),
  validateIbexIp: jest.fn((_req, _res, next) => next()),
}))

jest.mock("@services/mongoose/accounts", () => ({
  AccountsRepository: jest.fn(),
}))

jest.mock("@services/mongoose/ibex-crypto-receive-log", () => ({
  createIbexCryptoReceive: jest.fn(),
  isIbexCryptoReceiveProcessed: jest.fn(),
  markIbexCryptoReceiveProcessed: jest.fn(),
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
  promoteBridgeDepositForCryptoReceive: jest.fn(),
}))

jest.mock("@services/alerts/ibex-bridge-movement", () => ({
  alertIbexCryptoReceiveFailure: jest.fn(),
  alertIbexReconciliationFailed: jest.fn(),
}))

import {
  authenticate,
  logRequest,
  validateIbexIp,
} from "@services/ibex/webhook-server/middleware"
import {
  cryptoReceiveHandler,
  paths,
  router,
} from "@services/ibex/webhook-server/routes/crypto-receive"
import { AccountsRepository } from "@services/mongoose/accounts"
import {
  createIbexCryptoReceive,
  isIbexCryptoReceiveProcessed,
  markIbexCryptoReceiveProcessed,
} from "@services/mongoose/ibex-crypto-receive-log"
import { sendBridgeDepositNotificationBestEffort } from "@app/bridge/send-deposit-notification"
import { recordIbexCryptoReceive } from "@app/bridge/record-crypto-receive"
import { listWalletsByAccountId } from "@app/wallets"
import { LockService } from "@services/lock"
import { WalletCurrency } from "@domain/shared"
import {
  promoteBridgeDepositForCryptoReceive,
  writeIbexCryptoReceiveRequest,
} from "@services/frappe/BridgeTransferRequestWriter"
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
    ;(isIbexCryptoReceiveProcessed as jest.Mock).mockResolvedValue(false)
    ;(markIbexCryptoReceiveProcessed as jest.Mock).mockResolvedValue(true)
    ;(listWalletsByAccountId as jest.Mock).mockResolvedValue([
      { id: WALLET_ID, currency: WalletCurrency.Usdt },
    ])
    ;(writeIbexCryptoReceiveRequest as jest.Mock).mockResolvedValue(true)
    ;(promoteBridgeDepositForCryptoReceive as jest.Mock).mockResolvedValue("completed")
  })

  it("protects the route with rate limit, IP allowlist, auth, and request logging", () => {
    const routeLayer = (
      router.stack as Array<{
        route?: { path: string; stack: Array<{ handle: unknown }> }
      }>
    ).find((layer) => layer.route?.path === paths.cryptoReceive)

    expect(routeLayer).toBeDefined()
    const handles = routeLayer!.route!.stack.map((layer) => layer.handle)

    const validateIndex = handles.indexOf(validateIbexIp)
    const authIndex = handles.indexOf(authenticate)
    const logIndex = handles.indexOf(logRequest)
    const handlerIndex = handles.indexOf(cryptoReceiveHandler)

    expect(validateIndex).toBeGreaterThan(0)
    expect(authIndex).toBeGreaterThan(validateIndex)
    expect(logIndex).toBeGreaterThan(authIndex)
    expect(handlerIndex).toBeGreaterThan(logIndex)
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

  it("promotes the matching Bridge deposit row after writing the settle row", async () => {
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

    expect(promoteBridgeDepositForCryptoReceive).toHaveBeenCalledWith({
      txHash: TX_HASH,
      accountId: ACCOUNT_ID,
      walletId: WALLET_ID,
    })
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ status: "success" })
  })

  it("still succeeds when no deposit row matches the tx hash yet", async () => {
    ;(promoteBridgeDepositForCryptoReceive as jest.Mock).mockResolvedValue("not_found")
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

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ status: "success" })
    expect(alertIbexCryptoReceiveFailure).not.toHaveBeenCalled()
  })

  it("treats an already-completed deposit row as success without alerting", async () => {
    ;(promoteBridgeDepositForCryptoReceive as jest.Mock).mockResolvedValue(
      "already_completed",
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

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ status: "success" })
    expect(alertIbexCryptoReceiveFailure).not.toHaveBeenCalled()
  })

  // ENG-889: a refunded deposit's row is Failed and stays Failed, but USDT
  // reaching the customer for it is a mismatch ops must see.
  it("alerts but still succeeds when the deposit row is Failed (refunded)", async () => {
    ;(promoteBridgeDepositForCryptoReceive as jest.Mock).mockResolvedValue("kept_failed")
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

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ status: "success" })
    expect(alertIbexCryptoReceiveFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        txHash: TX_HASH,
        code: "credited_failed_bridge_deposit",
      }),
    )
  })

  it("alerts but still succeeds when the deposit-row promotion fails", async () => {
    ;(promoteBridgeDepositForCryptoReceive as jest.Mock).mockResolvedValue(
      new Error("erpnext down"),
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

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ status: "success" })
    expect(alertIbexCryptoReceiveFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        txHash: TX_HASH,
        code: "erpnext_promote_failed",
        title: "Bridge deposit audit row promotion failed",
      }),
    )
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
    // Left unprocessed, so a repeat delivery or the matcher retries it.
    expect(markIbexCryptoReceiveProcessed).not.toHaveBeenCalled()
    expect(sendBridgeDepositNotificationBestEffort).not.toHaveBeenCalled()
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

  // ENG-891: one path for the webhook and the hourly matcher.
  const validBody = {
    tx_hash: TX_HASH,
    address: ADDRESS,
    amount: "12.345678",
    currency: "USDT",
    network: "ethereum",
  }

  it("marks the receive processed after notifying the user", async () => {
    const res = makeResponse()

    await cryptoReceiveHandler({ body: validBody } as never, res as never)

    expect(sendBridgeDepositNotificationBestEffort).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      amount: "12.345678",
      currency: "USDT",
    })
    expect(markIbexCryptoReceiveProcessed).toHaveBeenCalledWith(TX_HASH)
    expect(
      (sendBridgeDepositNotificationBestEffort as jest.Mock).mock.invocationCallOrder[0],
    ).toBeLessThan(
      (markIbexCryptoReceiveProcessed as jest.Mock).mock.invocationCallOrder[0],
    )
  })

  it("skips a receive already processed: no second row, promotion or notification", async () => {
    ;(isIbexCryptoReceiveProcessed as jest.Mock).mockResolvedValue(true)
    const res = makeResponse()

    await cryptoReceiveHandler({ body: validBody } as never, res as never)

    expect(createIbexCryptoReceive).not.toHaveBeenCalled()
    expect(writeIbexCryptoReceiveRequest).not.toHaveBeenCalled()
    expect(promoteBridgeDepositForCryptoReceive).not.toHaveBeenCalled()
    expect(sendBridgeDepositNotificationBestEffort).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ status: "already_processed" })
  })

  it("processes anyway when the processed check cannot read the store", async () => {
    ;(isIbexCryptoReceiveProcessed as jest.Mock).mockResolvedValue(new Error("mongo"))
    const res = makeResponse()

    await cryptoReceiveHandler({ body: validBody } as never, res as never)

    expect(writeIbexCryptoReceiveRequest).toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ status: "success" })
  })

  it("still succeeds when marking processed fails", async () => {
    ;(markIbexCryptoReceiveProcessed as jest.Mock).mockResolvedValue(new Error("mongo"))
    const res = makeResponse()

    await cryptoReceiveHandler({ body: validBody } as never, res as never)

    expect(res.json).toHaveBeenCalledWith({ status: "success" })
  })

  it("returns 500 with persist_failed when the receive log cannot be written", async () => {
    ;(createIbexCryptoReceive as jest.Mock).mockResolvedValue(new Error("mongo"))
    const res = makeResponse()

    await cryptoReceiveHandler({ body: validBody } as never, res as never)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: "persist_failed" })
    expect(writeIbexCryptoReceiveRequest).not.toHaveBeenCalled()
  })

  it("records a matched credit without notifying when notifyUser is false", async () => {
    const result = await recordIbexCryptoReceive({
      txHash: TX_HASH,
      address: ADDRESS,
      amount: 489.51,
      ibexTransactionId: "ibex-tx-001",
      notifyUser: false,
      rawPayload: { source: "ibex_deposit_matcher" },
    })

    expect(result).toEqual({ status: "success" })
    expect(createIbexCryptoReceive).toHaveBeenCalledWith(
      expect.objectContaining({
        txHash: TX_HASH,
        amount: "489.51",
        currency: "USDT",
        network: "ethereum",
        ibexTransactionId: "ibex-tx-001",
      }),
    )
    expect(promoteBridgeDepositForCryptoReceive).toHaveBeenCalledWith({
      txHash: TX_HASH,
      accountId: ACCOUNT_ID,
      walletId: WALLET_ID,
    })
    expect(sendBridgeDepositNotificationBestEffort).not.toHaveBeenCalled()
    expect(markIbexCryptoReceiveProcessed).toHaveBeenCalledWith(TX_HASH)
  })
})
