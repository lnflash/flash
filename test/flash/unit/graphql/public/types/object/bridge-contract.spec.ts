import BridgeVirtualAccount from "@graphql/public/types/object/bridge-virtual-account"
import BridgeWithdrawal from "@graphql/public/types/object/bridge-withdrawal"
import { defaultFieldResolver } from "graphql"

describe("Bridge public GraphQL object contract", () => {
  it("exposes withdrawal fields returned by BridgeService", () => {
    const fields = BridgeWithdrawal.getFields()

    expect(fields).toHaveProperty("transferId")
    expect(fields).toHaveProperty("amount")
    expect(fields).toHaveProperty("currency")
    expect(fields).toHaveProperty("state")
    expect(fields).toHaveProperty("createdAt")
    expect(fields).not.toHaveProperty("id")
    expect(fields).not.toHaveProperty("status")
  })

  it("resolves withdrawal transferId and state from service-shaped results", () => {
    const fields = BridgeWithdrawal.getFields()
    const withdrawal = {
      transferId: "transfer-001",
      amount: "25.00",
      currency: "usdt",
      state: "pending",
      createdAt: "2026-06-05T00:00:00.000Z",
    }

    expect(
      defaultFieldResolver(withdrawal, {}, {}, { fieldName: "transferId" } as never),
    ).toBe("transfer-001")
    expect(
      defaultFieldResolver(withdrawal, {}, {}, { fieldName: "state" } as never),
    ).toBe("pending")
  })

  it("uses bridgeVirtualAccountId as the virtual account id returned by read queries", () => {
    const idField = BridgeVirtualAccount.getFields().id
    const virtualAccount = {
      bridgeVirtualAccountId: "bridge-va-001",
      bankName: "Test Bank",
      routingNumber: "123456789",
      accountNumber: "123456789012",
      accountNumberLast4: "9012",
    }

    expect(idField.resolve?.(virtualAccount, {}, {}, {})).toBe("bridge-va-001")
  })
})
