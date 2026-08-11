const mockGetFygaroSettings = jest.fn()
jest.mock("@services/fygaro/webhook-server/fygaro-settings", () => ({
  getFygaroSettings: (...a: unknown[]) => mockGetFygaroSettings(...a),
}))

import GlobalsQuery from "@graphql/public/root/query/globals"
import type { FygaroSettings } from "@services/fygaro/webhook-server/fygaro-settings"

// The `fygaroTopup` field on Globals is a hand-written remap of the ERPNext
// Fygaro Settings (minimumTopup -> minimumAmount, flashMargin* -> flashFee*,
// plus the processor fields). Every value is a Float, so TypeScript cannot
// catch a swapped source field — only a test can. These specs pin each field
// to its exact source and, because every source value below is distinct, would
// fail if any two were transposed (e.g. processorFeeFixed <-> flashFeeFixed).
type FygaroTopupField = {
  minimumAmount: number
  processorFeePercent: number
  processorFeeFixed: number
  flashFeePercent: number
  flashFeeFixed: number
} | null

type GlobalsResult = { fygaroTopup: FygaroTopupField }

const resolveGlobals = async (): Promise<GlobalsResult> => {
  const query = GlobalsQuery as unknown as {
    resolve: (
      source: null,
      args: Record<string, never>,
      context: unknown,
      info: never,
    ) => Promise<GlobalsResult>
  }
  return query.resolve(null, {}, {}, undefined as never)
}

// Deliberately all-distinct values so a swap of any two mapped fields is caught.
const SETTINGS: FygaroSettings = {
  processor: "Fygaro",
  processorFeePercent: 2.99,
  processorFeeFixed: 0.49,
  flashMarginPercent: 2.0,
  flashMarginFixed: 0.25,
  autoCreditLimit: 500,
  minimumTopup: 10,
  autoCreditEnabled: true,
}

beforeEach(() => {
  mockGetFygaroSettings.mockReset()
})

describe("globals query — fygaroTopup", () => {
  it("returns null when Fygaro Settings are unavailable", async () => {
    mockGetFygaroSettings.mockResolvedValue(undefined)

    const result = await resolveGlobals()

    expect(result.fygaroTopup).toBeNull()
  })

  it("maps each field from its exact settings source (no swaps)", async () => {
    mockGetFygaroSettings.mockResolvedValue({ ...SETTINGS })

    const result = await resolveGlobals()

    expect(result.fygaroTopup).toEqual({
      minimumAmount: SETTINGS.minimumTopup,
      processorFeePercent: SETTINGS.processorFeePercent,
      processorFeeFixed: SETTINGS.processorFeeFixed,
      flashFeePercent: SETTINGS.flashMarginPercent,
      flashFeeFixed: SETTINGS.flashMarginFixed,
    })
  })

  it("does not transpose the processor and flash fixed/percent fees", async () => {
    mockGetFygaroSettings.mockResolvedValue({ ...SETTINGS })

    const fygaroTopup = (await resolveGlobals()).fygaroTopup

    // Named assertions in addition to the structural toEqual above, so a swap
    // report points at the exact offending pair.
    expect(fygaroTopup?.flashFeePercent).toBe(SETTINGS.flashMarginPercent)
    expect(fygaroTopup?.flashFeeFixed).toBe(SETTINGS.flashMarginFixed)
    expect(fygaroTopup?.processorFeePercent).toBe(SETTINGS.processorFeePercent)
    expect(fygaroTopup?.processorFeeFixed).toBe(SETTINGS.processorFeeFixed)
    expect(fygaroTopup?.minimumAmount).toBe(SETTINGS.minimumTopup)
  })
})
