import { Money, Round, PRECISION_M } from "./bigint-money"
import { BigIntConversionError, UnsupportedCurrencyError } from "./errors"
import { WalletCurrency } from "./primitives"

// A USDT-specific `MoneyAmount` base + `USDTAmount` — nothing else lives here.
//
// This is NOT the base the app sees as `MoneyAmount`. The `@domain/shared` barrel does
// `export * from "./money"`, so ./money/MoneyAmount.ts is the canonical base the rest of
// the codebase resolves; the barrel takes only `{ USDTAmount }` from this file. Because
// `USDTAmount` extends THIS base and not ./money's, `x instanceof MoneyAmount` (the
// barrel's) does NOT match a USDTAmount — call sites that need to catch it add an explicit
// `|| x instanceof USDTAmount` (e.g. app/offers/storage/OffersSerde.ts). The two bases
// should be consolidated onto ./money (follow-up); until then, do NOT re-add USD/JMD/BTC
// classes here — those live in ./money, and duplicating them here is exactly what let a
// cashout fix land on a dead copy (ENG-518; #449 → #450).

export abstract class MoneyAmount {
  readonly money: Money
  readonly currencyCode: WalletCurrency

  constructor(amount: Money | bigint | string | number, currencyCode: WalletCurrency) {
    this.currencyCode = currencyCode
    if (amount instanceof Money) {
      this.money = amount
      return
    }
    this.money = new Money(amount, currencyCode, Round.HALF_TO_EVEN)
  }

  abstract getInstance(amount: Money): this

  multiplyBips(bips: BasisPoints): this {
    return this.getInstance(this.money.multiply(bips.toString()).divide(10000))
  }

  subtract(b: this): this {
    return this.getInstance(this.money.subtract(b.money))
  }

  isLesserThan(b: this): boolean {
    return this.money.isLesserThan(b.money)
  }

  isGreaterThan(b: this): boolean {
    return this.money.isGreaterThan(b.money)
  }

  isZero(): boolean {
    return this.money.isEqual(0)
  }

  toJson(): [string, string] {
    return this.money.toJSON()
  }

  asPaymentAmount(): PaymentAmount<WalletCurrency> {
    return {
      amount: this.money.toSource() / PRECISION_M,
      currency: this.currencyCode,
    }
  }

  fromSource(val: string, currency: WalletCurrency): this {
    return this.getInstance(new Money(val, currency, Round.HALF_TO_EVEN))
  }

  static fromJSON(val: [string, string]): MoneyAmount | Error {
    const [amt, currency] = val
    return this.from(amt, currency as WalletCurrency)
  }

  static from(amount: number | string, currency: WalletCurrency): MoneyAmount | Error {
    // Scoped to USDT — the only amount type this file owns. USD/JMD/BTC construction
    // goes through the ./money classes (and ./money/toMoneyAmount).
    if (currency === WalletCurrency.Usdt)
      return USDTAmount.smallestUnits(amount.toString())
    return new UnsupportedCurrencyError(`Could not read currency: ${currency}`)
  }
}

const USDT_MICROS_PER_MAJOR_UNIT = 1_000_000n
const USDT_MICROS_PER_USD_CENT = 10_000n

export class USDTAmount extends MoneyAmount {
  static currencyId: IbexCurrencyId = 29 as IbexCurrencyId

  private constructor(amount: Money | bigint | string | number) {
    super(amount, WalletCurrency.Usdt)
  }

  static smallestUnits(units: string | bigint): USDTAmount | BigIntConversionError {
    try {
      return new USDTAmount(units)
    } catch (error) {
      return new BigIntConversionError(
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  static usdCents(cents: string | bigint): USDTAmount | BigIntConversionError {
    try {
      const centAmt = new Money(cents.toString(), "USDTUsdCents", Round.HALF_TO_EVEN)
      const multiplier = USDTAmount.smallestUnits(USDT_MICROS_PER_USD_CENT)
      if (multiplier instanceof BigIntConversionError) return multiplier
      return new USDTAmount(multiplier.money.multiply(centAmt).toFixed(0))
    } catch (error) {
      return new BigIntConversionError(
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  static fromNumber(d: number | string): USDTAmount | BigIntConversionError {
    try {
      const usdtAmt = new Money(d.toString(), "USDT", Round.HALF_TO_EVEN)
      const multiplier = USDTAmount.smallestUnits(USDT_MICROS_PER_MAJOR_UNIT)
      if (multiplier instanceof BigIntConversionError) return multiplier
      return new USDTAmount(multiplier.money.multiply(usdtAmt).toFixed(0))
    } catch (error) {
      return new BigIntConversionError(
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  static ZERO = new USDTAmount(0)

  asSmallestUnits(precision: number = 0): string {
    return this.money.toFixed(precision)
  }

  asUsdCents(): string {
    return this.money.divide(USDT_MICROS_PER_USD_CENT.toString()).toFixed(0)
  }

  asNumber(precision: number = 6): string {
    return this.money.divide(USDT_MICROS_PER_MAJOR_UNIT.toString()).toFixed(precision)
  }

  toIbex(): number {
    return Number(this.asNumber(8))
  }

  getInstance(amount: Money): this {
    return new USDTAmount(amount) as this
  }
}
