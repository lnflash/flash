/**
 * Bridge service return shapes must match the public BridgeWithdrawal GraphQL type.
 *
 * Withdrawal mutation/query resolvers return BridgeService results directly with no
 * resolver-level field mapping, so the service is the source of truth for the GQL
 * contract: NonNull `id`, `amount`, `currency`, `status`, `createdAt`; optional
 * `externalAccountId`, `bridgeTransferId`, `failureReason`.
 */
jest.mock("@services/tracing", () => ({
  wrapAsyncFunctionsToRunInSpan: ({
    fns,
  }: {
    namespace: string
    fns: Record<string, (...args: unknown[]) => unknown>
  }) => fns,
}))

jest.mock("@config", () => ({
  ...jest.requireActual("@config"),
  BridgeConfig: { enabled: true, minWithdrawalAmount: 10, developerFeePercent: 2 },
}))

jest.mock("@services/logger", () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(),
  }
  logger.child.mockReturnValue(logger)
  return { baseLogger: logger }
})

jest.mock("@app/bridge/send-withdrawal-notification", () => ({
  sendBridgeWithdrawalNotificationBestEffort: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@services/frappe/BridgeTransferRequestWriter", () => ({
  writeBridgeCashoutPending: jest.fn().mockResolvedValue(true),
}))

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    getEthereumUsdtOption: jest.fn(),
    createCryptoReceiveInfo: jest.fn(),
    getCryptoSendRequirements: jest.fn(),
    createCryptoSendInfo: jest.fn(),
    sendOnchain: jest.fn(),
    sendCrypto: jest.fn(),
  },
}))

jest.mock("@services/mongoose/bridge-accounts", () => ({
  createExternalAccount: jest.fn(),
  createWithdrawal: jest.fn(),
  findPendingWithdrawalWithoutTransfer: jest.fn(),
  findExternalAccountsByAccountId: jest.fn(),
  markExternalAccountsMissingFromBridge: jest.fn(),
  findWithdrawalsByAccountId: jest.fn(),
  findWithdrawalById: jest.fn(),
  updateWithdrawalTransferId: jest.fn(),
  updateWithdrawalOnchainSend: jest.fn(),
}))

jest.mock("@services/bridge/client", () => ({
  __esModule: true,
  default: { createTransfer: jest.fn(), listExternalAccounts: jest.fn() },
}))

jest.mock("@services/mongoose/accounts", () => ({
  AccountsRepository: jest.fn(),
}))

jest.mock("@services/mongoose/wallets", () => ({
  WalletsRepository: jest.fn(),
}))

jest.mock("@app/wallets/get-balance-for-wallet", () => ({
  getBalanceForWallet: jest.fn(),
}))

jest.mock("@services/kratos", () => ({
  IdentityRepository: jest.fn(),
}))

jest.mock("@domain/primitives/bridge", () => ({
  toBridgeCustomerId: (id: string) => id,
  toBridgeExternalAccountId: (id: string) => id,
}))

jest.mock("@domain/shared", () => {
  class USDTAmount {
    static currencyId = 29

    private readonly ibexValue: number

    constructor(ibexValue: number) {
      this.ibexValue = ibexValue
    }

    toIbex() {
      return this.ibexValue
    }

    static fromNumber(value: number | string) {
      return new USDTAmount(Number(value))
    }
  }
  return { ...jest.requireActual("@domain/shared"), USDTAmount }
})

import BridgeService from "@services/bridge"
import * as BridgeAccountsRepo from "@services/mongoose/bridge-accounts"
import BridgeClient from "@services/bridge/client"
import { AccountsRepository } from "@services/mongoose/accounts"
import { WalletsRepository } from "@services/mongoose/wallets"
import { getBalanceForWallet } from "@app/wallets/get-balance-for-wallet"

const ACCOUNT_ID = "account-001" as AccountId
const EXTERNAL_ACCOUNT_ID = "ext-account-001"
const AMOUNT = "50"
const CUSTOMER_ID = "cust-001"
const ETHEREUM_ADDRESS = "ETH_ADDR_001"
const TRANSFER_ID = "transfer-bridge-001"
const WITHDRAWAL_ID = "withdrawal-mongo-001"
const BRIDGE_DEPOSIT_ADDRESS = "0xbridgeDepositAddress"
const IBEX_PAYOUT_ID = "ibex-payout-001"
const IBEX_CRYPTO_SEND_INFO_ID = "send-info-001"
const CREATED_AT = new Date("2026-06-05T00:00:00.000Z")

const mockAccount = {
  id: ACCOUNT_ID,
  level: 2,
  bridgeCustomerId: CUSTOMER_ID,
  bridgeEthereumAddress: ETHEREUM_ADDRESS,
  bridgeKycStatus: "approved",
  kratosUserId: "kratos-001",
}

const mockTransfer = {
  id: TRANSFER_ID,
  amount: AMOUNT,
  currency: "usd",
  state: "pending",
  source_deposit_instructions: {
    payment_rail: "ethereum",
    currency: "usdt",
    to_address: BRIDGE_DEPOSIT_ADDRESS,
  },
  receipt: {
    initial_amount: AMOUNT,
    developer_fee: "1.00",
    exchange_fee: "0.10",
    subtotal_amount: "48.90",
    final_amount: "48.90",
  },
}

const makeRow = (overrides: Record<string, unknown> = {}) => ({
  id: WITHDRAWAL_ID,
  accountId: ACCOUNT_ID as string,
  amount: AMOUNT,
  currency: "usdt",
  externalAccountId: EXTERNAL_ACCOUNT_ID,
  status: "pending" as const,
  bridgeTransferId: undefined,
  failureReason: undefined,
  createdAt: CREATED_AT,
  ...overrides,
})

const setupGuards = () => {
  const { USDTAmount } = jest.requireMock("@domain/shared") as {
    USDTAmount: new (ibexValue: number) => { toIbex: () => number }
  }

  ;(AccountsRepository as jest.Mock).mockReturnValue({
    findById: jest.fn().mockResolvedValue(mockAccount),
  })
  ;(WalletsRepository as jest.Mock).mockReturnValue({
    listByAccountId: jest
      .fn()
      .mockResolvedValue([{ id: "wallet-001", currency: "USDT", type: "checking" }]),
  })
  ;(getBalanceForWallet as jest.Mock).mockResolvedValue(new USDTAmount(1000))
  ;(BridgeAccountsRepo.findExternalAccountsByAccountId as jest.Mock).mockResolvedValue([
    {
      bridgeExternalAccountId: EXTERNAL_ACCOUNT_ID,
      bankName: "Test Bank",
      accountNumberLast4: "1111",
      status: "verified",
    },
  ])
  ;(BridgeAccountsRepo.createExternalAccount as jest.Mock).mockResolvedValue({
    bridgeExternalAccountId: EXTERNAL_ACCOUNT_ID,
    bankName: "Test Bank",
    accountNumberLast4: "1111",
    status: "verified",
  })
  ;(
    BridgeAccountsRepo.markExternalAccountsMissingFromBridge as jest.Mock
  ).mockResolvedValue({ modifiedCount: 0 })
  ;(BridgeClient.listExternalAccounts as jest.Mock).mockResolvedValue({
    data: [
      {
        id: EXTERNAL_ACCOUNT_ID,
        customer_id: CUSTOMER_ID,
        account_owner_name: "Dread",
        account_type: "us",
        currency: "usd",
        bank_name: "Test Bank",
        account_number_last_4: "1111",
        active: true,
        created_at: "2026-06-05T00:00:00.000Z",
      },
    ],
    has_more: false,
  })
  ;(BridgeAccountsRepo.findWithdrawalById as jest.Mock).mockResolvedValue(makeRow())
  ;(BridgeAccountsRepo.updateWithdrawalTransferId as jest.Mock).mockResolvedValue({
    ...makeRow(),
    bridgeTransferId: TRANSFER_ID,
    bridgeDeveloperFee: "1.00",
    bridgeExchangeFee: "0.10",
    subtotalAmount: "48.90",
    finalAmount: "48.90",
    status: "submitted" as const,
  })
  ;(BridgeAccountsRepo.updateWithdrawalOnchainSend as jest.Mock).mockResolvedValue({
    ...makeRow(),
    bridgeTransferId: TRANSFER_ID,
    bridgeDeveloperFee: "1.00",
    bridgeExchangeFee: "0.10",
    subtotalAmount: "48.90",
    finalAmount: "48.90",
    ibexPayoutId: IBEX_PAYOUT_ID,
    status: "usdt_sent" as const,
  })
  const IbexClient = jest.requireMock("@services/ibex/client").default
  ;(IbexClient.getCryptoSendRequirements as jest.Mock).mockResolvedValue({
    requirementsId: "send-requirements-001",
    data: { address: { required: true } },
  })
  ;(IbexClient.createCryptoSendInfo as jest.Mock).mockResolvedValue({
    id: IBEX_CRYPTO_SEND_INFO_ID,
    data: { address: BRIDGE_DEPOSIT_ADDRESS },
  })
  ;(IbexClient.sendCrypto as jest.Mock).mockResolvedValue({
    transaction: { id: IBEX_PAYOUT_ID, status: "PENDING" },
  })
  ;(IbexClient.sendOnchain as jest.Mock).mockResolvedValue({
    status: "PENDING",
    transactionHub: { id: IBEX_PAYOUT_ID },
  })
  ;(BridgeClient.createTransfer as jest.Mock).mockResolvedValue(mockTransfer)
}

describe("initiateWithdrawal — BridgeWithdrawal GraphQL contract shape", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setupGuards()
  })

  it("returns every NonNull field required by the BridgeWithdrawal GraphQL type", async () => {
    const result = await BridgeService.initiateWithdrawal(ACCOUNT_ID, WITHDRAWAL_ID)

    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return

    expect(result.id).toBe(WITHDRAWAL_ID)
    expect(result.amount).toBe(AMOUNT)
    expect(result.currency).toBe("usdt")
    expect(result.status).toBe("usdt_sent")
    expect(result.createdAt).toBe(CREATED_AT.toISOString())
    expect(result.bridgeTransferId).toBe(TRANSFER_ID)
    expect((result as Record<string, unknown>).transferId).toBeUndefined()
    expect((result as Record<string, unknown>).state).toBeUndefined()
  })
})

describe("getWithdrawals — BridgeWithdrawal GraphQL contract shape", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(AccountsRepository as jest.Mock).mockReturnValue({
      findById: jest.fn().mockResolvedValue(mockAccount),
    })
  })

  it("maps Mongo rows to id/status (not legacy transferId/state)", async () => {
    ;(BridgeAccountsRepo.findWithdrawalsByAccountId as jest.Mock).mockResolvedValue([
      makeRow({
        bridgeTransferId: TRANSFER_ID,
        status: "submitted",
        failureReason: "ACH return",
      }),
    ])

    const result = await BridgeService.getWithdrawals(ACCOUNT_ID)

    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: WITHDRAWAL_ID,
      amount: AMOUNT,
      currency: "usdt",
      externalAccountId: EXTERNAL_ACCOUNT_ID,
      status: "submitted",
      bridgeTransferId: TRANSFER_ID,
      failureReason: "ACH return",
      createdAt: CREATED_AT.toISOString(),
    })
    expect((result[0] as Record<string, unknown>).transferId).toBeUndefined()
    expect((result[0] as Record<string, unknown>).state).toBeUndefined()
  })

  it("excludes rows without bridgeTransferId so NonNull id/status never resolve undefined", async () => {
    ;(BridgeAccountsRepo.findWithdrawalsByAccountId as jest.Mock).mockResolvedValue([
      makeRow({ status: "pending" }),
      makeRow({ id: "w-cancelled", status: "cancelled" }),
      makeRow({
        id: "w-submitted",
        bridgeTransferId: TRANSFER_ID,
        status: "submitted",
      }),
    ])

    const result = await BridgeService.getWithdrawals(ACCOUNT_ID)

    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("w-submitted")
    expect(result[0].status).toBe("submitted")
  })
})
