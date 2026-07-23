import { GraphQLResolveInfo, GraphQLUnionType } from "graphql"

import InitiationVia from "@graphql/shared/types/abstract/initiation-via"
import SettlementVia from "@graphql/shared/types/abstract/settlement-via"
import { baseLogger } from "@services/logger"

const resolve = (union: GraphQLUnionType, source: { type?: string }) =>
  union.resolveType?.(source, {}, {} as GraphQLResolveInfo, union)

describe("InitiationVia union", () => {
  it("resolves known initiation methods to their object types", () => {
    expect(resolve(InitiationVia, { type: "intraledger" })).toBe(
      "InitiationViaIntraLedger",
    )
    expect(resolve(InitiationVia, { type: "lightning" })).toBe("InitiationViaLn")
    expect(resolve(InitiationVia, { type: "onchain" })).toBe("InitiationViaOnChain")
  })

  it("falls back to InitiationViaIntraLedger for unrecognized sources instead of failing the query", () => {
    const errorSpy = jest.spyOn(baseLogger, "error").mockImplementation()

    expect(resolve(InitiationVia, { type: "unknown" })).toBe("InitiationViaIntraLedger")
    expect(resolve(InitiationVia, {})).toBe("InitiationViaIntraLedger")
    expect(errorSpy).toHaveBeenCalled()

    errorSpy.mockRestore()
  })
})

describe("SettlementVia union", () => {
  it("resolves known settlement methods to their object types", () => {
    expect(resolve(SettlementVia, { type: "intraledger" })).toBe(
      "SettlementViaIntraLedger",
    )
    expect(resolve(SettlementVia, { type: "lightning" })).toBe("SettlementViaLn")
    expect(resolve(SettlementVia, { type: "onchain" })).toBe("SettlementViaOnChain")
  })

  it("falls back to SettlementViaIntraLedger for unrecognized sources instead of failing the query", () => {
    const errorSpy = jest.spyOn(baseLogger, "error").mockImplementation()

    expect(resolve(SettlementVia, { type: "unknown" })).toBe("SettlementViaIntraLedger")
    expect(resolve(SettlementVia, {})).toBe("SettlementViaIntraLedger")
    expect(errorSpy).toHaveBeenCalled()

    errorSpy.mockRestore()
  })
})
