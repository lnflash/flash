import { USDAmount, USDTAmount } from "@domain/shared"
import USDCentsScalar from "@graphql/shared/types/scalar/usd-cents"

describe("USDCentsScalar", () => {
  it("serializes USD amounts as cents", () => {
    const amount = USDAmount.cents("123")
    if (amount instanceof Error) throw amount

    expect(USDCentsScalar.serialize(amount)).toBe(123)
  })

  it("serializes USDT amounts as micro-USDT units", () => {
    const amount = USDTAmount.smallestUnits("1234567")
    if (amount instanceof Error) throw amount

    expect(USDCentsScalar.serialize(amount)).toBe(1234567)
  })
})
