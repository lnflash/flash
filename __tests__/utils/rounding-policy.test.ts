import { RoundingPolicy } from "../../src/utils/rounding-policy"

describe("RoundingPolicy", () => {
  describe("accounting (banker's)", () => {
    it.each([
      [2.5, 2],
      [3.5, 4],
      [-2.5, -2],
      [-3.5, -4],
      [0.5, 0],
      [1.5, 2],
      [2.4, 2],
      [2.6, 3],
      [-2.4, -2],
      [-2.6, -3],
      [0, 0],
      [-0, 0],
    ])("rounds %f -> %i", (input, expected) => {
      expect(RoundingPolicy.round(input, "accounting")).toBe(expected)
    })
  })

  describe("display (half-up symmetric)", () => {
    it.each([
      [2.5, 3],
      [3.5, 4],
      [-2.5, -3],
      [-3.5, -4],
      [2.4, 2],
      [2.6, 3],
      [-2.4, -2],
      [-2.6, -3],
    ])("rounds %f -> %i", (input, expected) => {
      expect(RoundingPolicy.round(input, "display")).toBe(expected)
    })
  })

  describe("fee (ceiling)", () => {
    it.each([
      [2.1, 3],
      [2.0, 2],
      [-2.1, -2],
      [-2.9, -2],
    ])("rounds %f -> %i", (input, expected) => {
      expect(RoundingPolicy.round(input, "fee")).toBe(expected)
    })
  })

  it("throws on NaN / Infinity", () => {
    expect(() => RoundingPolicy.round(NaN, "accounting")).toThrow()
    expect(() => RoundingPolicy.round(Infinity, "fee")).toThrow()
  })
})
