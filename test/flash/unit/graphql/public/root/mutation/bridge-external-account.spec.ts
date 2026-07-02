jest.mock("@services/bridge", () => ({
  __esModule: true,
  default: {
    setDefaultExternalAccount: jest.fn(),
    deleteExternalAccount: jest.fn(),
  },
}))

jest.mock("@config", () => ({
  BridgeConfig: { enabled: true },
  getOnChainWalletConfig: jest.fn().mockReturnValue({ dustThreshold: 546 }),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import BridgeService from "@services/bridge"
import BridgeSetDefaultExternalAccountMutation from "@graphql/public/root/mutation/bridge-set-default-external-account"
import BridgeDeleteExternalAccountMutation from "@graphql/public/root/mutation/bridge-delete-external-account"

const ACCOUNT_ID = "account-001" as AccountId
const EXTERNAL_ACCOUNT_ID = "ext-001"

const ctx = {
  domainAccount: { id: ACCOUNT_ID, level: 2 },
} as unknown as GraphQLPublicContextAuth

type BridgeExternalAccountMutationResult = {
  errors: Array<{ code?: string; message?: string }>
  externalAccount?: {
    id?: string
    bankName?: string
    accountNumberLast4?: string
    status?: string
    isDefault?: boolean
  }
}

type BridgeExternalAccountMutation = {
  resolve?: (
    source: null,
    args: { input: { externalAccountId: string } },
    context: GraphQLPublicContextAuth,
    info: never,
  ) => Promise<unknown> | unknown
}

const resolveBridgeMutation = async (
  mutation: BridgeExternalAccountMutation,
): Promise<BridgeExternalAccountMutationResult> => {
  if (!mutation.resolve) throw new Error("Missing resolver")
  return (await mutation.resolve(
    null,
    { input: { externalAccountId: EXTERNAL_ACCOUNT_ID } },
    ctx,
    {} as never,
  )) as BridgeExternalAccountMutationResult
}

const externalAccount = {
  bridgeExternalAccountId: EXTERNAL_ACCOUNT_ID,
  bankName: "Test Bank",
  accountNumberLast4: "1111",
  status: "verified",
  isDefault: true,
}

describe("Bridge external account mutations", () => {
  beforeEach(() => jest.clearAllMocks())

  it("sets the default external account for the current account", async () => {
    ;(BridgeService.setDefaultExternalAccount as jest.Mock).mockResolvedValue(
      externalAccount,
    )

    const result = await resolveBridgeMutation(
      BridgeSetDefaultExternalAccountMutation as BridgeExternalAccountMutation,
    )

    expect(BridgeService.setDefaultExternalAccount).toHaveBeenCalledWith(
      ACCOUNT_ID,
      EXTERNAL_ACCOUNT_ID,
    )
    expect(result.errors).toEqual([])
    expect(result.externalAccount).toEqual(externalAccount)
  })

  it("deletes the external account for the current account", async () => {
    ;(BridgeService.deleteExternalAccount as jest.Mock).mockResolvedValue({
      ...externalAccount,
      status: "failed",
      isDefault: false,
    })

    const result = await resolveBridgeMutation(
      BridgeDeleteExternalAccountMutation as BridgeExternalAccountMutation,
    )

    expect(BridgeService.deleteExternalAccount).toHaveBeenCalledWith(
      ACCOUNT_ID,
      EXTERNAL_ACCOUNT_ID,
    )
    expect(result.errors).toEqual([])
    expect(result.externalAccount?.status).toBe("failed")
    expect(result.externalAccount?.isDefault).toBe(false)
  })
})
