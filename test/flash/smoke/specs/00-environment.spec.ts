import { gqlOk } from "../client"
import { SMOKE } from "../config"

// UAT: SETUP-01 (environment reachable and healthy)
describe("SETUP: environment", () => {
  it("SETUP-01: GraphQL endpoint responds with globals", async () => {
    const data = await gqlOk<{
      globals: { network: string; lightningAddressDomain: string }
    }>(
      `query smokeGlobals {
        globals { network lightningAddressDomain }
      }`,
    )
    expect(data.globals.network).toBeTruthy()
    expect(data.globals.lightningAddressDomain).toBeTruthy()
    // Surface where we're pointed so CI logs are self-describing.
    // eslint-disable-next-line no-console
    console.log(
      `smoke target: ${SMOKE.endpoint} network=${data.globals.network} flagsOff=${SMOKE.expectFlagsOff}`,
    )
  })
})
