jest.mock("@config", () => {
  const path = require("path")
  const { I18n } = require("i18n")
  const i18n = new I18n()
  i18n.configure({
    objectNotation: true,
    updateFiles: false,
    locales: ["en", "es"],
    defaultLocale: "en",
    retryInDefaultLocale: true,
    directory: path.resolve(__dirname, "../../../../../../src/config/locales"),
  })
  return {
    getI18nInstance: () => i18n,
    getLocale: () => "en",
  }
})

import BridgeVirtualAccount from "@graphql/public/types/object/bridge-virtual-account"
import BridgeWithdrawal from "@graphql/public/types/object/bridge-withdrawal"
import { defaultFieldResolver } from "graphql"
import { getBridgeWithdrawalFlashFeeNotice } from "@app/bridge/get-withdrawal-flash-fee-notice"

describe("Bridge public GraphQL object contract", () => {
  it("exposes withdrawal fields returned by BridgeService", () => {
    const fields = BridgeWithdrawal.getFields()

    expect(fields).toHaveProperty("id")
    expect(fields).toHaveProperty("amount")
    expect(fields).toHaveProperty("currency")
    expect(fields).toHaveProperty("externalAccountId")
    expect(fields).toHaveProperty("status")
    expect(fields).toHaveProperty("estimatedBridgeFeePercent")
    expect(fields).toHaveProperty("estimatedBridgeFee")
    expect(fields).toHaveProperty("estimatedGasBuffer")
    expect(fields).toHaveProperty("estimatedCustomerFee")
    expect(fields).toHaveProperty("flashFeePercent")
    expect(fields).toHaveProperty("flashFee")
    expect(fields).toHaveProperty("flashFeeIsEstimate")
    expect(fields).toHaveProperty("flashFeeNotice")
    expect(fields).toHaveProperty("bridgeDeveloperFee")
    expect(fields).toHaveProperty("bridgeExchangeFee")
    expect(fields).toHaveProperty("subtotalAmount")
    expect(fields).toHaveProperty("finalAmount")
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
      flashFeePercent: "2",
      flashFee: "0.50",
      flashFeeIsEstimate: true,
      bridgeTransferId: undefined,
      createdAt: "2026-06-05T00:00:00.000Z",
    }

    expect(fields.id).toBeDefined()
    expect(fields.status).toBeDefined()
    expect(fields.bridgeTransferId).toBeDefined()

    expect(
      defaultFieldResolver(withdrawal, {}, {}, { fieldName: "id", field: fields.id } as never),
    ).toBe("withdrawal-001")
    expect(
      defaultFieldResolver(
        withdrawal,
        {},
        {},
        { fieldName: "status", field: fields.status } as never,
      ),
    ).toBe("pending")
    expect(
      defaultFieldResolver(
        withdrawal,
        {},
        {},
        { fieldName: "bridgeTransferId", field: fields.bridgeTransferId } as never,
      ),
    ).toBeUndefined()
  })

  it("resolves flashFeeNotice from the user locale when amounts are estimated", () => {
    const fields = BridgeWithdrawal.getFields()
    const withdrawal = {
      flashFeeIsEstimate: true,
    }
    const ctx = { user: { language: "es" } } as GraphQLPublicContextAuth

    expect(fields.flashFeeNotice.resolve?.(withdrawal, {}, ctx, {})).toBe(
      getBridgeWithdrawalFlashFeeNotice("es"),
    )
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
