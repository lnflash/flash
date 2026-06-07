import BridgeVirtualAccount from "@graphql/public/types/object/bridge-virtual-account"
import BridgeWithdrawal from "@graphql/public/types/object/bridge-withdrawal"
import { defaultFieldResolver } from "graphql"

describe("Bridge public GraphQL object contract", () => {
  it("exposes withdrawal fields returned by BridgeService", () => {
    const fields = BridgeWithdrawal.getFields()

    expect(fields).toHaveProperty("id")
    expect(fields).toHaveProperty("amount")
    expect(fields).toHaveProperty("currency")
    expect(fields).toHaveProperty("externalAccountId")
    expect(fields).toHaveProperty("status")
    expect(fields).toHaveProperty("bridgeTransferId")
    expect(fields).toHaveProperty("failureReason")
    expect(fields).toHaveProperty("createdAt")
    expect(fields).not.toHaveProperty("transferId")
    expect(fields).not.toHaveProperty("state")
  })

  it("resolves withdrawal id and status from service-shaped results", () => {
    const fields = BridgeWithdrawal.getFields()
    const withdrawal = {
      id: "withdrawal-001",
      amount: "25.00",
      currency: "usdt",
      externalAccountId: "ext-001",
      status: "pending",
      bridgeTransferId: undefined,
      createdAt: "2026-06-05T00:00:00.000Z",
    }

    expect(
      defaultFieldResolver(withdrawal, {}, {}, { fieldName: "id" } as never),
    ).toBe("withdrawal-001")
    expect(
      defaultFieldResolver(withdrawal, {}, {}, { fieldName: "status" } as never),
    ).toBe("pending")
    expect(
      defaultFieldResolver(withdrawal, {}, {}, { fieldName: "bridgeTransferId" } as never),
    ).toBeUndefined()
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
