export type RoundingContext = "accounting" | "display" | "fee"

const roundHalfToEven = (n: number): number => {
  const floor = Math.floor(n)
  const diff = n - floor
  if (diff < 0.5) return floor
  if (diff > 0.5) return floor + 1
  return floor % 2 === 0 ? floor : floor + 1
}

const roundHalfUp = (n: number): number =>
  Math.sign(n) * Math.floor(Math.abs(n) + 0.5)

export const RoundingPolicy = {
  round(amount: number, context: RoundingContext): number {
    if (!Number.isFinite(amount)) {
      throw new Error(`RoundingPolicy: non-finite amount (${amount})`)
    }

    switch (context) {
      case "accounting":
        return roundHalfToEven(amount)
      case "display":
        return roundHalfUp(amount)
      case "fee":
        return Math.ceil(amount)
    }
  },
} as const
