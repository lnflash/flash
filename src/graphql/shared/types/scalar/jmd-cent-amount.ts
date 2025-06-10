import { JMDAmount } from "@domain/shared"
import { GT } from "@graphql/index"

const JMDCentsScalar = GT.Scalar({
    name: "JMDCents",
    description: "Amount in Jamaican cents",
    parseValue(value: unknown): JMDAmount {
      let amt = value as number | string 
      const amount = JMDAmount.cents(amt.toString())
      if (amount instanceof Error) {
          throw new Error(`Invalid JMD amount: ${value}`)
      }
      return amount
    },
    serialize(value: unknown): number {
        if (value instanceof JMDAmount) {
            return Number(value.asCents()) 
        }
        else throw new Error(`Failed to serialize JMDAmount: ${value}`)
    }
})

export default JMDCentsScalar