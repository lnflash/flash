// Resolver-level tests for the US-only Plaid gate wiring: a non-US IP must
// short-circuit to BRIDGE_PLAID_NOT_AVAILABLE (which the client routes to
// manual entry), must NOT open a Plaid session, and must emit an ops-feed
// event; a US IP proceeds normally and emits nothing.

jest.mock("@services/bridge", () => ({
  __esModule: true,
  default: {
    plaidGateForIp: jest.fn(),
    addExternalAccount: jest.fn(),
  },
}))

jest.mock("@config", () => ({
  BridgeConfig: { enabled: true },
  getOnChainWalletConfig: jest.fn().mockReturnValue({ dustThreshold: 546 }),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: jest.fn(),
}))

import BridgeService from "@services/bridge"
import { notifyOpsEvent } from "@services/alerts/ops-events"
import BridgeAddExternalAccountMutation from "@graphql/public/root/mutation/bridge-add-external-account"

const ACCOUNT_ID = "account-001" as AccountId

const ctxWithIp = (ipValue?: string) =>
  ({
    domainAccount: { id: ACCOUNT_ID, level: 2 },
    ip: ipValue as unknown as IpAddress | undefined,
  }) as unknown as GraphQLPublicContextAuth

type MutationResult = {
  errors: Array<{ code?: string; message?: string }>
  externalAccount?: unknown
}

type ResolvableMutation = {
  resolve?: (
    source: null,
    args: Record<string, never>,
    context: GraphQLPublicContextAuth,
    info: never,
  ) => Promise<unknown> | unknown
}

const resolveAddExternal = async (
  ctx: GraphQLPublicContextAuth,
): Promise<MutationResult> => {
  const mutation = BridgeAddExternalAccountMutation as ResolvableMutation
  if (!mutation.resolve) throw new Error("Missing resolver")
  return (await mutation.resolve(null, {}, ctx, {} as never)) as MutationResult
}

describe("bridgeAddExternalAccount — US-only Plaid gate", () => {
  beforeEach(() => jest.clearAllMocks())

  it("blocks a non-US IP: returns BRIDGE_PLAID_NOT_AVAILABLE, skips Plaid, notifies ops", async () => {
    ;(BridgeService.plaidGateForIp as jest.Mock).mockResolvedValue({
      available: false,
      country: "JM",
    })

    const result = await resolveAddExternal(ctxWithIp("69.160.103.177"))

    expect(BridgeService.plaidGateForIp).toHaveBeenCalledWith("69.160.103.177")
    // The whole point: Plaid is never requested for a blocked IP.
    expect(BridgeService.addExternalAccount).not.toHaveBeenCalled()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].code).toBe("BRIDGE_PLAID_NOT_AVAILABLE")
    expect(result.externalAccount).toBeUndefined()
    // Ops-feed signal carries the resolved country.
    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "cashout",
        phase: "plaid-blocked-non-us",
        status: "failed",
        accountId: ACCOUNT_ID,
        meta: { country: "JM" },
      }),
    )
  })

  it("issues the Plaid link token when the IP is allowed (US) and notifies nothing", async () => {
    ;(BridgeService.plaidGateForIp as jest.Mock).mockResolvedValue({
      available: true,
      country: "US",
    })
    const linkResult = { linkToken: "link-tok", expiresAt: "later" }
    ;(BridgeService.addExternalAccount as jest.Mock).mockResolvedValue(linkResult)

    const result = await resolveAddExternal(ctxWithIp("8.8.8.8"))

    expect(BridgeService.addExternalAccount).toHaveBeenCalledWith(ACCOUNT_ID)
    expect(notifyOpsEvent).not.toHaveBeenCalled()
    expect(result.errors).toEqual([])
    expect(result.externalAccount).toEqual(linkResult)
  })
})
