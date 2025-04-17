import { JMDAmount, USDAmount } from "@domain/shared/MoneyAmount"
import JmdAmount from "@graphql/shared/types/scalar/jmd-amount"

describe("Money Amount", () => {
  
  describe("Subtract", () => {
    it("should subtract two amounts of the same currency", () => {
      const a = USDAmount.cents('10000') // $100.00
      if (a instanceof Error) throw a
      const b = USDAmount.cents('2500') // $50.00
      if (b instanceof Error) throw b

      const result = a.subtract(b)
      expect(result.asCents()).toBe('7500') // $150.00
    })
  })
  
  describe("multiplyBips", () => {
    it("should multiply expected fee", () => {
      const amount = USDAmount.cents('10000') // $100.00
      if (amount instanceof Error) throw amount
      const result = amount.multiplyBips(250n as BasisPoints) // 2.5%
      expect(result.asCents()).toBe('250') // $2.50
    })
  })

  describe("Currency Conversions", () => {
    it("should convert a USDAmount to a JMDAmount at a given rate", () => {
      const usdAmount = USDAmount.dollars(100) 
      if (usdAmount instanceof Error) throw usdAmount
      const rate = JMDAmount.dollars(160) // 1 USD = 160 JMD
      if (rate instanceof Error) throw rate
      const jmdprice = usdAmount.convertAtRate(rate) 
      expect(jmdprice.asDollars()).toBe('16000.00') 
    })
  })
  
  describe("USD Amount", () => {
    it("should get the cent amount with default precision of 0", () => {
      const cents = USDAmount.cents('1.2345')// $123.45
      if (cents instanceof Error) throw cents
      expect(cents.asCents()).toBe('1')
    })

    it("should get the cent amount with custom precision of 1", () => {
      const cents = USDAmount.cents('1.2345')// $123.45
      if (cents instanceof Error) throw cents
      expect(cents.asCents(1)).toBe('1.2')
    })
    it("should get the dollar amount with default precision of 2", () => {
      const cents = USDAmount.cents('1.2345')// $123.45
      if (cents instanceof Error) throw cents

      // Expected result: 12345 / 10^2 = 123.45
      expect(cents.asCents()).toBe('1')
      expect(cents.asCents(1)).toBe('1.2')
      expect(cents.asDollars()).toBe('0.01')
      expect(cents.asDollars(3)).toBe('0.012')
    })

    it("should get the dollar amount with custom precision", () => {
      const cents = USDAmount.cents('1.2345')// $123.45
      if (cents instanceof Error) throw cents
      expect(cents.asDollars(3)).toBe('0.012')
    })

    it("should get the cent amount from dollars", () => {
      const cents = USDAmount.dollars('1.23')// $1.2345
      if (cents instanceof Error) throw cents
      expect(cents.asCents()).toBe('123')
    })

    it("should calculate the correct percentage using mulBasisPoints", () => {
      const amount = USDAmount.cents('10000') // $100.00
      if (amount instanceof Error) throw amount
      const result = amount.multiplyBips(250n as BasisPoints) // 2.5%
      expect(result.asCents()).toBe('250') // $2.50
    })

    it("should calculate the correct dollar percentage using mulBasisPoints", () => {
      const amount = USDAmount.dollars('100.0') // $100.00
      if (amount instanceof Error) throw amount
      const result = amount.multiplyBips(250n as BasisPoints) // 2.5%
      expect(result.asCents()).toBe('250') // $2.50
    })

    it("should subtract two FractionalAmount instances with the same offset", () => {
      const a = USDAmount.cents('10000.54321') 
      if (a instanceof Error) throw a
      const b = USDAmount.cents('250') 
      if (b instanceof Error) throw b

      const result = a.subtract(b)

      expect(result.asCents()).toBe('9751') 
    })

    describe("toIbex", () => {
      it("should handle fractional cents", () => {
        const amt = USDAmount.cents("12.3456789")  
        if (amt instanceof Error) throw amt
        
        expect(amt.toIbex()).toBe(.12345679) // rounds to 8 decimal places
      })

      it("should handle zero", () => {
        const amt = USDAmount.cents("0")
        if (amt instanceof Error) throw amt
        
        expect(amt.toIbex()).toBe(0)
      })
    })
  })
})