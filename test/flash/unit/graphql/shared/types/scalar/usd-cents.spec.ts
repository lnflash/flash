import { USDAmount, USDTAmount } from "@domain/shared"
import USDCentsScalar from "@graphql/shared/types/scalar/usd-cents"

describe("USDCentsScalar", () => {
  it("serializes USD amounts as cents", () => {
    const amount = USDAmount.cents("123")
    if (amount instanceof Error) throw amount

    expect(USDCentsScalar.serialize(amount)).toBe(123)
  })

  it("serializes USDT amounts as USD cents", () => {
    const amount = USDTAmount.smallestUnits("1230000")
    if (amount instanceof Error) throw amount

    expect(USDCentsScalar.serialize(amount)).toBe(123)
  })

  it("serializes USDT sub-cent amounts as fractional USD cents", () => {
    const amount = USDTAmount.smallestUnits("9147993")
    if (amount instanceof Error) throw amount

    expect(USDCentsScalar.serialize(amount)).toBe(914.7993)
  })
})
