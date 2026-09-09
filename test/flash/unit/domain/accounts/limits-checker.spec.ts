import { getAccountLimits } from "@config"
import { AccountLimitsChecker } from "@domain/accounts"
import { LimitsExceededError } from "@domain/errors"
import { WalletPriceRatio } from "@domain/payments"
import {
  AmountCalculator,
  paymentAmountFromNumber,
  WalletCurrency,
  ZERO_CENTS,
} from "@domain/shared"

let usdPaymentAmount: UsdPaymentAmount
let limitsChecker: AccountLimitsChecker
let walletVolumeIntraledger: TxBaseVolumeAmount<WalletCurrency>
let walletVolumeWithdrawal: TxBaseVolumeAmount<WalletCurrency>
let priceRatio: WalletPriceRatio

const calc = AmountCalculator()

const ONE_CENT = { amount: 1n, currency: WalletCurrency.Usd } as UsdPaymentAmount

beforeAll(async () => {
  const priceRatioResult = WalletPriceRatio({
    usd: ONE_CENT,
    btc: { amount: 50n, currency: WalletCurrency.Btc },
  })
  if (priceRatioResult instanceof Error) throw priceRatioResult
  priceRatio = priceRatioResult

  const level: AccountLevel = 1
  const accountLimits = getAccountLimits({ level })

  usdPaymentAmount = {
    amount: 10_000n,
    currency: WalletCurrency.Usd,
  }

  limitsChecker = AccountLimitsChecker({
    accountLimits,
    priceRatio,
  })

  const intraLedgerOutgoingBaseAmount = paymentAmountFromNumber({
    amount: accountLimits.intraLedgerLimit - Number(usdPaymentAmount.amount),
    currency: WalletCurrency.Usd,
  })
  if (intraLedgerOutgoingBaseAmount instanceof Error) throw intraLedgerOutgoingBaseAmount
  walletVolumeIntraledger = {
    outgoingBaseAmount: intraLedgerOutgoingBaseAmount,
    incomingBaseAmount: ZERO_CENTS,
  }

  const withdrawalOutgoingBaseAmount = paymentAmountFromNumber({
    amount: accountLimits.withdrawalLimit - Number(usdPaymentAmount.amount),
    currency: WalletCurrency.Usd,
  })
  if (withdrawalOutgoingBaseAmount instanceof Error) throw withdrawalOutgoingBaseAmount
  walletVolumeWithdrawal = {
    outgoingBaseAmount: withdrawalOutgoingBaseAmount,
    incomingBaseAmount: ZERO_CENTS,
  }
})

describe("LimitsChecker", () => {
  it("passes for exact limit amount", async () => {
    const intraledgerLimitCheck = await limitsChecker.checkIntraledger({
      amount: usdPaymentAmount,
      walletVolumes: [walletVolumeIntraledger],
    })
    expect(intraledgerLimitCheck).not.toBeInstanceOf(Error)

    const withdrawalLimitCheck = await limitsChecker.checkWithdrawal({
      amount: usdPaymentAmount,
      walletVolumes: [walletVolumeWithdrawal],
    })
    expect(withdrawalLimitCheck).not.toBeInstanceOf(Error)
  })

  it("passes for amount below limit", async () => {
    const intraledgerLimitCheck = await limitsChecker.checkIntraledger({
      amount: calc.sub(usdPaymentAmount, ONE_CENT),
      walletVolumes: [walletVolumeIntraledger],
    })
    expect(intraledgerLimitCheck).not.toBeInstanceOf(Error)

    const withdrawalLimitCheck = await limitsChecker.checkWithdrawal({
      amount: calc.sub(usdPaymentAmount, ONE_CENT),
      walletVolumes: [walletVolumeWithdrawal],
    })
    expect(withdrawalLimitCheck).not.toBeInstanceOf(Error)
  })

  it("returns an error for exceeded intraledger amount", async () => {
    const intraledgerLimitCheck = await limitsChecker.checkIntraledger({
      amount: calc.add(usdPaymentAmount, ONE_CENT),
      walletVolumes: [walletVolumeIntraledger],
    })
    expect(intraledgerLimitCheck).toBeInstanceOf(LimitsExceededError)
  })

  it("returns an error for exceeded withdrawal amount", async () => {
    const withdrawalLimitCheck = await limitsChecker.checkWithdrawal({
      amount: calc.add(usdPaymentAmount, ONE_CENT),
      walletVolumes: [walletVolumeWithdrawal],
    })
    expect(withdrawalLimitCheck).toBeInstanceOf(LimitsExceededError)
  })
})

// ENG-573 moved "an account with no `level` is level 0" into
// `getAccountLimits`, the config layer — so THIS checker, which is Galoy's and
// predates the send guard, reads it too (`@app/payments/helpers` passes
// `account.level` straight through). Its only inputs are the limits and a price
// ratio: there is no `sendGuard.mode` parameter and no way for it to consult
// one, which is precisely why `sendGuard.mode: off` cannot lift the cap it
// applies here. docs/send-guard.md ("What `off` does not cover") is the runbook
// half of this; these cases are the executable half.
describe("LimitsChecker — an account with no level (ENG-573)", () => {
  const unleveledLimits = getAccountLimits({ level: undefined })
  const noVolume = [
    { outgoingBaseAmount: ZERO_CENTS, incomingBaseAmount: ZERO_CENTS },
  ] as TxBaseVolumeAmount<WalletCurrency>[]
  const twoHundredDollars: UsdPaymentAmount = {
    amount: 20_000n,
    currency: WalletCurrency.Usd,
  }

  const checkerForUnleveledAccount = () =>
    AccountLimitsChecker({ accountLimits: unleveledLimits, priceRatio })

  it("is handed the level-0 caps, not NaN", () => {
    expect(unleveledLimits).toEqual(getAccountLimits({ level: 0 as AccountLevel }))
    expect(unleveledLimits.withdrawalLimit).toBe(12500)
    expect(unleveledLimits.intraLedgerLimit).toBe(12500)
  })

  // Zero volume, because Flash has no internal ledger — so the amount alone is
  // what refuses this, and the message the caller sees is Galoy's, not the
  // guard's. This is the string the runbook quotes.
  it("refuses a $200 withdrawal on the amount alone, with the level-0 message", async () => {
    const check = await checkerForUnleveledAccount().checkWithdrawal({
      amount: twoHundredDollars,
      walletVolumes: noVolume,
    })

    expect(check).toBeInstanceOf(LimitsExceededError)
    expect((check as LimitsExceededError).message).toBe(
      "Cannot transfer more than $125.00 in 24 hours",
    )
  })

  it("refuses the same amount intraledger", async () => {
    const check = await checkerForUnleveledAccount().checkIntraledger({
      amount: twoHundredDollars,
      walletVolumes: noVolume,
    })

    expect(check).toBeInstanceOf(LimitsExceededError)
    expect((check as LimitsExceededError).message).toBe(
      "Cannot transfer more than $125.00 in 24 hours",
    )
  })

  // Pre-ENG-573 this cohort indexed the level map with `undefined`, got NaN
  // limits, and `paymentAmountFromNumber(NaN)` returned a BigIntConversionError
  // out of `checkLimit` — the send failed with a type error rather than a limit.
  // Under the cap the send now goes through, which is the improvement; above it
  // the refusal is a real limit message.
  it("lets a send under the level-0 cap through, where NaN limits used to error", async () => {
    const atTheCap: UsdPaymentAmount = { amount: 12_500n, currency: WalletCurrency.Usd }
    const check = await checkerForUnleveledAccount().checkWithdrawal({
      amount: atTheCap,
      walletVolumes: noVolume,
    })

    expect(check).not.toBeInstanceOf(Error)
  })
})
