import { context as otelContext, trace, Span } from "@opentelemetry/api"

import { addAttributesToCurrentSpan } from "@services/tracing"

// `addAttributesToCurrentSpan` is not a passthrough: it sets an attribute only
// `if (value)`, so every falsy value handed to it is dropped silently. Call
// sites that need a number on the span stringify it for that reason
// (`send-lightning.ts`, `ledger/volume.ts`, and the ENG-573 send-guard census
// in `authorize-send.ts`, which shipped `"sendGuard.level": AccountLevel.Zero`
// — `0` — and recorded nothing at all for the ~300 unleveled prod accounts the
// rollout exists to count).
//
// Anything that mocks this function must mirror the filter or it green-lights
// values production throws away; test/flash/unit/app/payments/authorize-send.spec.ts
// mirrors it and points here.

const attributesSetOn = (
  attributes: Parameters<typeof addAttributesToCurrentSpan>[0],
) => {
  const setAttribute = jest.fn()
  const span = { setAttribute } as unknown as Span
  otelContext.with(trace.setSpan(otelContext.active(), span), () =>
    addAttributesToCurrentSpan(attributes),
  )
  return setAttribute.mock.calls
}

describe("addAttributesToCurrentSpan", () => {
  it("drops every falsy value, the number 0 included", () => {
    expect(
      attributesSetOn({
        zero: 0,
        emptyString: "",
        untrue: false,
        kept: "value",
      }),
    ).toEqual([["kept", "value"]])
  })

  it("keeps a stringified zero, which is how a call site records one", () => {
    expect(attributesSetOn({ level: String(0), cents: String(0) })).toEqual([
      ["level", "0"],
      ["cents", "0"],
    ])
  })

  it("does nothing, rather than throwing, when there is no active span", () => {
    expect(() => addAttributesToCurrentSpan({ kept: "value" })).not.toThrow()
  })
})
