import path from "path"

const protobuf = require("protobufjs")

// Both price streams cross the gRPC boundary as a single scalar: `PriceResponse.price`
// (src/services/price/protos/price.proto) and `Tick.price`
// (src/services/price/protos/price_history.proto). `float` in protobuf is 32-bit
// IEEE 754 — about 7 significant digits — so a rate such as 157.1234567 (JMD) or
// 392.9876543 (NGN), multiplied onward through the 8-decimal sat math in
// `getRealTimePrice`, is silently rounded inside the wire layer where no caller can
// see it. `double` keeps the value the JS number already holds.
//
// The stubs are loaded at runtime straight from these .proto files (see
// src/services/price/grpc.ts), so the schema *is* the contract: encoding and decoding
// through the loaded type is the same round trip a gRPC call performs, without needing
// a price-server on the other end.

const PROTO_DIR = path.join(__dirname, "../../../../../src/services/price/protos")

const loadRoot = (file: string) => protobuf.loadSync(path.join(PROTO_DIR, file))

const roundTrip = (root: any, typeName: string, value: number) => {
  const type = root.lookupType(typeName)
  const bytes = type.encode(type.create({ price: value })).finish()

  return type.decode(bytes).price as number
}

describe("price protos keep full rate precision", () => {
  const priceRoot = loadRoot("price.proto")
  const historyRoot = loadRoot("price_history.proto")

  it("declares PriceResponse.price as double", () => {
    expect(priceRoot.lookupType("PriceResponse").fields.price.type).toBe("double")
  })

  it("declares Tick.price as double", () => {
    expect(historyRoot.lookupType("Tick").fields.price.type).toBe("double")
  })

  it.each([
    [157.123456789], // JMD-style rate carried through sat-scale precision
    [392.987654321], // NGN-style rate
    [0.0000000123456], // sub-cent sats-per-unit ratio
  ])("round-trips %p through PriceResponse bit-for-bit", (rate) => {
    expect(roundTrip(priceRoot, "PriceResponse", rate)).toBe(rate)
  })

  it("round-trips a history tick alongside its timestamp", () => {
    const type = historyRoot.lookupType("Tick")
    const rate = 157.123456789
    const bytes = type
      .encode(type.create({ timestamp: "1700000000", price: rate }))
      .finish()
    const decoded = type.decode(bytes)

    expect(decoded.price).toBe(rate)
    expect(decoded.timestamp.toString()).toBe("1700000000")
  })

  it("shows what a 32-bit field would have done to the same rate", () => {
    const rate = 157.123456789
    const view = new DataView(new ArrayBuffer(8))
    view.setFloat32(0, rate)

    expect(view.getFloat32(0)).not.toBe(rate)
  })
})
