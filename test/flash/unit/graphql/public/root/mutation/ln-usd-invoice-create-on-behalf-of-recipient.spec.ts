const mockAddInvoiceForRecipientForUsdWallet = jest.fn()
const mockResolveCashWalletRecipientMutationWalletId = jest.fn()

jest.mock("@app", () => ({
  Wallets: {
    addInvoiceForRecipientForUsdWallet: (
      ...args: Parameters<typeof mockAddInvoiceForRecipientForUsdWallet>
    ) => mockAddInvoiceForRecipientForUsdWallet(...args),
  },
}))

jest.mock("@app/cash-wallet-cutover", () => ({
  resolveCashWalletRecipientMutationWalletId: (
    ...args: Parameters<typeof mockResolveCashWalletRecipientMutationWalletId>
  ) => mockResolveCashWalletRecipientMutationWalletId(...args),
}))

import LnUsdInvoiceCreateOnBehalfOfRecipientMutation from "@graphql/public/root/mutation/ln-usd-invoice-create-on-behalf-of-recipient"

const recipientWalletId = "11111111-1111-4111-8111-111111111111" as WalletId
const routedWalletId = "22222222-2222-4222-8222-222222222222" as WalletId
const amount = 1234 as UsdCents
const invoice = { paymentRequest: "lnbc1-routed" } as LnInvoice

const client = {
  cashWalletPresentation: "usdt",
  hasUsdtCashWalletSupport: true,
} as const

describe("LnUsdInvoiceCreateOnBehalfOfRecipientMutation", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResolveCashWalletRecipientMutationWalletId.mockResolvedValue(routedWalletId)
    mockAddInvoiceForRecipientForUsdWallet.mockResolvedValue(invoice)
  })

  it("routes fixed-amount recipient invoices through the recipient account active settlement wallet", async () => {
    const result = await LnUsdInvoiceCreateOnBehalfOfRecipientMutation.resolve?.(
      null,
      {
        input: {
          recipientWalletId,
          amount,
          memo: "recipient memo" as Memo,
          descriptionHash: undefined,
          expiresIn: 5 as Minutes,
        },
      },
      { cashWalletClientCapabilities: client } as GraphQLPublicContext,
      {} as never,
    )

    expect(mockResolveCashWalletRecipientMutationWalletId).toHaveBeenCalledWith({
      recipientWalletId,
      client,
    })
    expect(mockAddInvoiceForRecipientForUsdWallet).toHaveBeenCalledWith({
      recipientWalletId: routedWalletId,
      amount,
      memo: "recipient memo",
      descriptionHash: undefined,
      expiresIn: 5,
    })
    expect(result).toEqual({
      errors: [],
      invoice,
    })
  })
})
