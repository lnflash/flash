jest.mock("@services/mongoose/cash-wallet-cutover", () => ({
  CashWalletCutoverRepository: jest.fn(),
}))

import CashWalletCutoverQuery from "@graphql/shared/root/query/cash-wallet-cutover"
import CashWalletCutoverUpdateMutation from "@graphql/admin/root/mutation/cash-wallet-cutover-update"
import { CashWalletCutoverRepository } from "@services/mongoose/cash-wallet-cutover"

describe("cash wallet cutover GraphQL surface", () => {
  const updatedAt = new Date("2026-05-22T12:00:00Z")

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns the public cutover flag state", async () => {
    const getConfig = jest.fn(async () => ({
      state: "in_progress" as const,
      cutoverVersion: 7,
      runId: "run-7",
      scheduledAt: new Date("2026-05-22T13:00:00Z"),
      updatedAt,
    }))
    jest.mocked(CashWalletCutoverRepository).mockReturnValue({ getConfig } as never)

    const result = await CashWalletCutoverQuery.resolve?.(
      null,
      {},
      {} as GraphQLPublicContext,
      {} as never,
    )

    expect(result).toMatchObject({
      state: "in_progress",
      cutoverVersion: 7,
      runId: "run-7",
      scheduledAt: new Date("2026-05-22T13:00:00Z"),
    })
  })

  it("lets admins mutate the cutover flag", async () => {
    const updateConfig = jest.fn(async () => ({
      state: "in_progress" as const,
      cutoverVersion: 8,
      runId: "run-8",
      updatedBy: "admin-user-id",
      updatedAt,
    }))
    jest.mocked(CashWalletCutoverRepository).mockReturnValue({ updateConfig } as never)

    const result = await CashWalletCutoverUpdateMutation.resolve?.(
      null,
      {
        input: {
          state: "in_progress",
          cutoverVersion: 8,
          runId: "run-8",
        },
      },
      { user: { id: "admin-user-id" } } as GraphQLAdminContext,
      {} as never,
    )

    expect(updateConfig).toHaveBeenCalledWith(
      {
        state: "in_progress",
        cutoverVersion: 8,
        runId: "run-8",
      },
      "admin-user-id",
    )
    expect(result).toMatchObject({
      errors: [],
      cashWalletCutover: {
        state: "in_progress",
        cutoverVersion: 8,
        runId: "run-8",
      },
    })
  })
})
