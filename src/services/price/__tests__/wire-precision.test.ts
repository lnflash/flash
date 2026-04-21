/**
 * Wire-precision smoke test for ENG-317 (float→double rollout, Phase A).
 *
 * Demonstrates that:
 *   1. The legacy `float` field exhibits drift on JMD-class rates.
 *   2. The new `double` field carries the JS number through unchanged.
 *   3. The client-side `preferDouble` helper picks the new field when
 *      present and falls back to the old field when it isn't (i.e. when
 *      talking to a pre-ENG-317 server).
 *
 * Pure unit test — no actual gRPC server is started; we synthesize the
 * decoded message shape that `@grpc/proto-loader` produces with
 * `defaults: true`.
 */

const SATS_PER_BTC = 100_000_000

// Float32 round-trip helper. The `Float32Array` truncates the JS number
// (which is a float64) down to 32-bit precision, then reads it back as a
// float64. This is exactly what protobuf's `float` field does on the wire.
const float32RoundTrip = (n: number): number => {
  const buf = new Float32Array(1)
  buf[0] = n
  return buf[0]
}

// Same shape as the helper inside src/services/price/index.ts. Kept here to
// avoid pulling in the full module (which imports gRPC + config). If you
// change one, change the other.
const preferDouble = (resp: { price?: number; price_v2?: number }): number =>
  resp.price_v2 || resp.price || 0

describe("ENG-317 wire precision", () => {
  describe("float vs double round-trip drift", () => {
    // Realistic, decimal-noisy rates — i.e. rates whose binary expansion
    // exceeds the 24-bit float32 mantissa. Round numbers like 157.5,
    // 60_000, or 9_400_000 happen to be exactly representable in float32
    // and so demonstrate nothing; real-world FX feeds are not that tidy.
    const samples: ReadonlyArray<{ name: string; rate: number }> = [
      { name: "JMD per sat (the ENG-316 culprit)", rate: 9.45 },
      { name: "JMD per BTC (intraday)", rate: 9_456_321.07 },
      { name: "USD per BTC (intraday)", rate: 65_432.17 },
      { name: "JPY per BTC (intraday)", rate: 9_415_287.31 },
    ]

    for (const { name, rate } of samples) {
      it(`${name}: float32 wire drifts vs float64`, () => {
        // The double sits in JS already (Number === float64). The float
        // round-trip is what the legacy `float price = 1` field does.
        const f32 = float32RoundTrip(rate)
        const f64 = rate

        // For every sample above the float32 representation differs from
        // the float64 by a measurable amount.
        expect(f32).not.toBe(f64)
        // Float32 has ~24 bits of mantissa → relative error bounded by
        // ~6e-8. Locking that in catches an accidental promotion of the
        // helper to float64 (which would silently make this test pass for
        // the wrong reason).
        const relDrift = Math.abs(f32 - f64) / Math.abs(f64)
        expect(relDrift).toBeGreaterThan(0)
        expect(relDrift).toBeLessThan(1e-6)
      })
    }

    it("absolute J$ drift on a 1-BTC balance is large enough to matter", () => {
      // 1 BTC = 100M sats. The wire-only float32→float64 drift on the JMD
      // rate is roughly J$19 of uncertainty on a single 1-BTC quote. That's
      // the ENG-316 / roadmap §4.1 baseline this PR closes.
      const onBtc = SATS_PER_BTC
      const driftedTotal = onBtc * float32RoundTrip(9.45)
      const cleanTotal = onBtc * 9.45

      const absDrift = Math.abs(driftedTotal - cleanTotal)
      // The drift is materially larger than 1 JMD-cent.
      expect(absDrift).toBeGreaterThan(1)
      // Sanity ceiling — keeps this test honest if anyone "fixes" it later
      // by accidentally widening to float64.
      expect(absDrift).toBeLessThan(1000)
    })

    it("absolute J$ drift on a typical 10k-sat retail amount is sub-cent", () => {
      // The damage is amount-proportional; on a 10k-sat amount the wire
      // drift is < 0.01 JMD-cent. The Phase 0 hotfix (ENG-316) was needed
      // because the *non-rounding* of the displayed JMD compounded this
      // into visible UI dust. The double wire eliminates the input drift
      // before any display rounding has to compensate.
      const tenK = 10_000
      const drift = Math.abs(tenK * 9.45 - tenK * float32RoundTrip(9.45))
      expect(drift).toBeLessThan(0.01)
      expect(drift).toBeGreaterThan(0)
    })
  })

  describe("preferDouble — client field selection", () => {
    it("uses price_v2 when the new server populates it", () => {
      // New server — both fields populated. price_v2 is double-exact;
      // price has been quantised through float32 on the wire.
      const rate = 9.45
      expect(preferDouble({ price: float32RoundTrip(rate), price_v2: rate })).toBe(
        rate,
      )
    })

    it("falls back to price when the server is pre-ENG-317", () => {
      // Old server — only the legacy field is on the wire. proto-loader
      // with `defaults: true` synthesises price_v2 = 0 for the missing
      // field. The fallback must trigger.
      const rate = float32RoundTrip(9.45)
      expect(preferDouble({ price: rate, price_v2: 0 })).toBe(rate)
    })

    it("returns 0 when both fields are missing or zero", () => {
      // Sentinel for "no price available" — caller maps this to
      // PriceNotAvailableError.
      expect(preferDouble({})).toBe(0)
      expect(preferDouble({ price: 0, price_v2: 0 })).toBe(0)
    })

    it("never silently uses a stale float when the double is present and non-zero", () => {
      // Belt-and-braces: price_v2 wins even when price is also a non-zero
      // (drifted) value.
      const v2 = 9.45
      const v1 = float32RoundTrip(9.45)
      expect(v1).not.toBe(v2)
      expect(preferDouble({ price: v1, price_v2: v2 })).toBe(v2)
    })
  })

  describe("Tick (price_history) shape", () => {
    it("price_v2 takes precedence inside Tick rows the same way", () => {
      const tick = {
        timestamp: 1_700_000_000,
        price: float32RoundTrip(9.45),
        price_v2: 9.45,
      }
      // Same selection logic; documented at the call site in index.ts.
      const selected = tick.price_v2 || tick.price
      expect(selected).toBe(9.45)
      expect(selected / SATS_PER_BTC).toBe(9.45 / SATS_PER_BTC)
    })
  })
})
