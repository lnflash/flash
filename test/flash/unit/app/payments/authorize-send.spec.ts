const mockConsumeLimiter = jest.fn()
jest.mock("@services/rate-limit", () => ({
  consumeLimiter: (args: unknown) => mockConsumeLimiter(args),
}))

const mockUsdFromBtcMidPriceFn = jest.fn()
jest.mock("@app/prices/mid-price", () => ({
  usdFromBtcMidPriceFn: (args: unknown) => mockUsdFromBtcMidPriceFn(args),
}))

const mockNotifyOpsEvent = jest.fn()
jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: (event: unknown) => mockNotifyOpsEvent(event),
}))

import { getAccountLimits } from "@config"

import { authorizeSend } from "@app/payments/authorize-send"

import { AccountLevel } from "@domain/accounts"
import {
  IntraledgerLimitsExceededError,
  WithdrawalLimitsExceededError,
} from "@domain/errors"
import {
  InvalidSendAmountError,
  SendLimitsUnavailableError,
} from "@domain/payments/errors"
import { RateLimitConfig } from "@domain/rate-limit"
import {
  PaymentSendRateLimiterExceededError,
  UnknownRateLimitServiceError,
} from "@domain/rate-limit/errors"
import { DealerPriceServiceError } from "@domain/dealer-price"
import { WalletCurrency } from "@domain/shared"

const ACCOUNT_ID = "507f1f77bcf86cd799439011" as AccountId
const WALLET_ID = "ea9e6e57-430e-4c87-bd54-4eee0f7869b8" as WalletId

const account = (level: AccountLevel | undefined): Account =>
  ({ id: ACCOUNT_ID, level }) as unknown as Account

const send = (
  overrides: Partial<Parameters<typeof authorizeSend>[0]> = {},
): Promise<true | ApplicationError> =>
  authorizeSend({
    senderAccount: account(AccountLevel.Zero),
    senderWalletId: WALLET_ID,
    amount: { currency: "USD", cents: 100 },
    kind: "intraledger",
    ...overrides,
  })

const lastOpsEvent = () => mockNotifyOpsEvent.mock.calls.at(-1)?.[0]

// Schema defaults (src/config/schema.ts) — the numbers the guard enforces today.
const L0 = getAccountLimits({ level: AccountLevel.Zero })
const L1 = getAccountLimits({ level: AccountLevel.One })
const L2 = getAccountLimits({ level: AccountLevel.Two })
const L3 = getAccountLimits({ level: AccountLevel.Three })

describe("authorizeSend (ENG-573 Phase 0 send guard)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockConsumeLimiter.mockResolvedValue(true)
  })

  describe("attempt budget", () => {
    it("consumes the burst bucket then the daily bucket, keyed on the account, and authorises a sane amount", async () => {
      expect(await send()).toBe(true)
      expect(mockConsumeLimiter.mock.calls).toEqual([
        [{ rateLimitConfig: RateLimitConfig.paymentSend, keyToConsume: ACCOUNT_ID }],
        [{ rateLimitConfig: RateLimitConfig.paymentSendDaily, keyToConsume: ACCOUNT_ID }],
      ])
      expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
    })

    it("rejects when the burst bucket is exhausted, without touching the daily bucket", async () => {
      const err = new PaymentSendRateLimiterExceededError()
      mockConsumeLimiter.mockResolvedValueOnce(err)
      expect(await send()).toBe(err)
      expect(mockConsumeLimiter).toHaveBeenCalledTimes(1)
      expect(lastOpsEvent()).toMatchObject({
        flow: "transfer",
        phase: "rejected",
        status: "failed",
        accountId: ACCOUNT_ID,
        error: "PaymentSendRateLimiterExceededError",
        meta: { reason: "rate-limited", senderWalletId: WALLET_ID, kind: "intraledger" },
      })
    })

    it("rejects when the daily bucket is exhausted", async () => {
      const err = new PaymentSendRateLimiterExceededError()
      mockConsumeLimiter.mockResolvedValueOnce(true).mockResolvedValueOnce(err)
      expect(await send()).toBe(err)
      expect(mockConsumeLimiter).toHaveBeenCalledTimes(2)
    })

    it("fails closed on a rate-limit store fault", async () => {
      const fault = new UnknownRateLimitServiceError("redis down")
      mockConsumeLimiter.mockResolvedValueOnce(fault)
      expect(await send()).toBe(fault)
      expect(lastOpsEvent()?.meta.reason).toBe("rate-limited")
    })

    it("charges the budget even for an attempt it then rejects on amount", async () => {
      const result = await send({ amount: { currency: "USD", cents: -1 } })
      expect(result).toBeInstanceOf(InvalidSendAmountError)
      expect(mockConsumeLimiter).toHaveBeenCalledTimes(2)
    })
  })

  describe("amount sanity", () => {
    it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY, -0.01])(
      "rejects USD cents %p",
      async (cents) => {
        const result = await send({ amount: { currency: "USD", cents } })
        expect(result).toBeInstanceOf(InvalidSendAmountError)
        expect(lastOpsEvent()?.meta.reason).toBe("invalid-amount")
      },
    )

    it("accepts fractional USD cents (USDT settles in micros)", async () => {
      expect(await send({ amount: { currency: "USD", cents: 12.5 } })).toBe(true)
    })

    it("accepts bigint USD cents", async () => {
      expect(await send({ amount: { currency: "USD", cents: 250n } })).toBe(true)
    })

    it("accepts numeric-string cents (the FractionalCentAmount scalar type is a branded string)", async () => {
      expect(await send({ amount: { currency: "USD", cents: "12.5" } })).toBe(true)
    })

    it.each(["", "abc", "-3", "0"])("rejects string cents %p", async (cents) => {
      const result = await send({ amount: { currency: "USD", cents } })
      expect(result).toBeInstanceOf(InvalidSendAmountError)
    })

    it.each([0, -1, 1.5])("rejects sats %p", async (sats) => {
      const result = await send({ amount: { currency: "BTC", sats } })
      expect(result).toBeInstanceOf(InvalidSendAmountError)
      expect(mockUsdFromBtcMidPriceFn).not.toHaveBeenCalled()
    })
  })

  describe("daily limit as per-transaction cap", () => {
    it("allows exactly the level-0 intraledger limit and rejects one cent more", async () => {
      expect(
        await send({ amount: { currency: "USD", cents: L0.intraLedgerLimit } }),
      ).toBe(true)

      const result = await send({
        amount: { currency: "USD", cents: L0.intraLedgerLimit + 1 },
      })
      expect(result).toBeInstanceOf(IntraledgerLimitsExceededError)
      expect((result as Error).message).toBe(
        `Cannot transfer more than $${(L0.intraLedgerLimit / 100).toFixed(2)} in 24 hours`,
      )
      expect(lastOpsEvent()).toMatchObject({
        phase: "rejected",
        amount: { value: ((L0.intraLedgerLimit + 1) / 100).toFixed(2), currency: "USD" },
        error: "IntraledgerLimitsExceededError",
        meta: { reason: "over-daily-limit", level: "0" },
      })
    })

    it.each(["lightning", "lnurl", "onchain"] as const)(
      "applies the withdrawal limit to %s sends",
      async (kind) => {
        // Level 1 has distinct intraledger ($2,000) and withdrawal ($1,000) limits.
        expect(L1.withdrawalLimit).toBeLessThan(L1.intraLedgerLimit)
        const between = L1.withdrawalLimit + 1

        const result = await send({
          senderAccount: account(AccountLevel.One),
          amount: { currency: "USD", cents: between },
          kind,
        })
        expect(result).toBeInstanceOf(WithdrawalLimitsExceededError)

        expect(
          await send({
            senderAccount: account(AccountLevel.One),
            amount: { currency: "USD", cents: between },
            kind: "intraledger",
          }),
        ).toBe(true)
      },
    )

    it("rejects the 2026-09-03 wall-of-nines ($999,999,999.99) at every level", async () => {
      for (const level of [
        AccountLevel.Zero,
        AccountLevel.One,
        AccountLevel.Two,
        AccountLevel.Three,
      ]) {
        const result = await send({
          senderAccount: account(level),
          amount: { currency: "USD", cents: 99_999_999_999 },
        })
        expect(result).toBeInstanceOf(IntraledgerLimitsExceededError)
      }
      expect(lastOpsEvent()?.amount).toEqual({ value: "999999999.99", currency: "USD" })
    })

    it("enforces the level-3 placeholder (inherits level 2) instead of failing closed", async () => {
      expect(L3.intraLedgerLimit).toBe(L2.intraLedgerLimit)
      expect(
        await send({
          senderAccount: account(AccountLevel.Three),
          amount: { currency: "USD", cents: L3.intraLedgerLimit },
        }),
      ).toBe(true)
      expect(
        await send({
          senderAccount: account(AccountLevel.Three),
          amount: { currency: "USD", cents: L3.intraLedgerLimit + 1 },
        }),
      ).toBeInstanceOf(IntraledgerLimitsExceededError)
    })

    it("treats an account with no level as level 0", async () => {
      expect(
        await send({
          senderAccount: account(undefined),
          amount: { currency: "USD", cents: L0.intraLedgerLimit },
        }),
      ).toBe(true)
      const result = await send({
        senderAccount: account(undefined),
        amount: { currency: "USD", cents: L0.intraLedgerLimit + 1 },
      })
      expect(result).toBeInstanceOf(IntraledgerLimitsExceededError)
      expect(lastOpsEvent()?.meta.level).toBe("0")
    })

    it("fails closed for a level with no configured limit", async () => {
      const result = await send({ senderAccount: account(9 as AccountLevel) })
      expect(result).toBeInstanceOf(SendLimitsUnavailableError)
      expect(lastOpsEvent()?.meta.reason).toBe("limits-unavailable")
    })
  })

  describe("sats-denominated sends", () => {
    it("converts sats to USD at the mid price and caps on the result", async () => {
      mockUsdFromBtcMidPriceFn.mockResolvedValue({
        amount: BigInt(L0.withdrawalLimit + 1),
        currency: WalletCurrency.Usd,
      })
      const result = await send({
        amount: { currency: "BTC", sats: 21_000 },
        kind: "lightning",
      })
      expect(result).toBeInstanceOf(WithdrawalLimitsExceededError)
      expect(mockUsdFromBtcMidPriceFn).toHaveBeenCalledWith({
        amount: 21_000n,
        currency: WalletCurrency.Btc,
      })
    })

    it("authorises when the converted amount is within the limit", async () => {
      mockUsdFromBtcMidPriceFn.mockResolvedValue({
        amount: BigInt(L0.withdrawalLimit),
        currency: WalletCurrency.Usd,
      })
      expect(
        await send({ amount: { currency: "BTC", sats: 21_000n }, kind: "lightning" }),
      ).toBe(true)
    })

    it("fails closed when no price is available", async () => {
      mockUsdFromBtcMidPriceFn.mockResolvedValue(new DealerPriceServiceError("offline"))
      const result = await send({
        amount: { currency: "BTC", sats: 1 },
        kind: "lightning",
      })
      expect(result).toBeInstanceOf(SendLimitsUnavailableError)
      expect(lastOpsEvent()?.meta.reason).toBe("limits-unavailable")
    })
  })
})
