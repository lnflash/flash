import { USDAmount } from "@domain/shared"
import { GT } from "@graphql/index"

const USDCentsScalar = GT.Scalar({
    name: "USDCents",
    description: "Amount in USD cents",
    parseValue(value: unknown): USDAmount {
      let amt = value as number | string 
      const amount = USDAmount.cents(amt.toString())
      if (amount instanceof Error) {
          throw new Error(`Invalid USD amount: ${value}`)
      }
      return amount
    },
    serialize(value: unknown): number {
        if (value instanceof USDAmount) {
            return Number(value.asCents(2)) 
        }
        else throw new Error(`Failed to serialize USDAmount: ${value}`)
    }
})

export default USDCentsScalar