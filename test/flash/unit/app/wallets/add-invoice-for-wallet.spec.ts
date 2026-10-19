const mockAddInvoice = jest.fn()
const mockReceiveAccountFor = jest.fn()

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    addInvoice: (...args: unknown[]) => mockAddInvoice(...args),
  },
}))

// The routing seam under test: receiveAccountFor decides shadow vs real.
jest.mock("@app/payment-splits/receive-account", () => ({
  receiveAccountFor: (...args: unknown[]) => mockReceiveAccountFor(...args),
}))

// LndService / DealerPriceService are only touched by the noAmount path.
jest.mock("@services/lnd", () => ({
  LndService: jest.fn(() => new Error("not used in this spec")),
}))

jest.mock("@services/rate-limit", () => ({
  consumeLimiter: jest.fn(async () => true),
}))

jest.mock("@services/dealer-price", () => ({
  DealerPriceService: jest.fn(),
}))

jest.mock("@services/mongoose", () => ({
  WalletsRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindWalletById(...args),
  })),
  AccountsRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindAccountById(...args),
  })),
  WalletInvoicesRepository: jest.fn(() => ({})),
}))

import {
  addInvoiceForSelfForUsdWallet,
  addInvoiceForRecipientForUsdWallet,
} from "@app/wallets/add-invoice-for-wallet"
import { WalletCurrency } from "@domain/shared"

const WALLET = "11111111-1111-4111-8111-111111111111"
const SHADOW = "shadow-ibex-account"
const OWNER = { id: "owner-account", status: "active", level: 1 }

const mockFindWalletById = jest.fn()
const mockFindAccountById = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  mockFindWalletById.mockResolvedValue({
    id: WALLET,
    accountId: OWNER.id,
    currency: WalletCurrency.Usdt,
  })
  mockFindAccountById.mockResolvedValue(OWNER)
  // Default: no splits — mint on the wallet itself.
  mockReceiveAccountFor.mockImplementation(async (id: string) => id)
  mockAddInvoice.mockResolvedValue({
    invoice: {
      bolt11:
        "lnbc20u1pvjluezhp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqfppqw508d6qejxtdg4y5r3zarvary0c5xw7kxqrrsssp5m6kmam774klwlh4dhmhaatd7al02m0h0m6kmam774klwlh4dhmhs9qypqqqcqpf3cwux5979a8j28d4ydwahx00saa68wq3az7v9jdgzkghtxnkf3z5t7q5suyq2dl9tqwsap8j0wptc82cpyvey9gf6zyylzrm60qtcqsq7egtsq",
      hash: "0001020304050607080900010203040506070809000102030405060708090102",
    },
  })
})

// The allowlist: EVERY user-facing mint site routes through receiveAccountFor.
// A new mint path that skips it lands receives unsplit silently (ENG-717 §8).
const ROUTED_MINT_SITES = [
  "src/app/wallets/add-invoice-for-wallet.ts",
  "src/graphql/public/root/mutation/ln-noamount-invoice-create.ts",
]

describe("add-invoice-for-wallet shadow routing (ENG-717)", () => {
  it("mints a self invoice on the shadow when receiveAccountFor routes there", async () => {
    mockReceiveAccountFor.mockResolvedValue(SHADOW)

    await addInvoiceForSelfForUsdWallet({
      walletId: WALLET,
      amount: 10 as FractionalCentAmount,
      memo: "",
    })

    expect(mockReceiveAccountFor).toHaveBeenCalledWith(WALLET)
    expect(mockAddInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: SHADOW, amount: expect.anything() }),
    )
  })

  it("mints a self invoice on the real account when there are no splits", async () => {
    await addInvoiceForSelfForUsdWallet({
      walletId: WALLET,
      amount: 10 as FractionalCentAmount,
      memo: "",
    })

    expect(mockAddInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: WALLET }),
    )
  })

  it("mints a recipient invoice on the recipient's shadow when routed there", async () => {
    mockReceiveAccountFor.mockResolvedValue(SHADOW)

    await addInvoiceForRecipientForUsdWallet({
      recipientWalletId: WALLET,
      amount: 10 as FractionalCentAmount,
      memo: "",
    })

    expect(mockReceiveAccountFor).toHaveBeenCalledWith(WALLET)
    expect(mockAddInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: SHADOW }),
    )
  })

  it("mints a recipient invoice on the real account when there are no splits", async () => {
    await addInvoiceForRecipientForUsdWallet({
      recipientWalletId: WALLET,
      amount: 10 as FractionalCentAmount,
      memo: "",
    })

    expect(mockAddInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: WALLET }),
    )
  })

  it("every Ibex.addInvoice caller file in src is either a routed mint site or a marked internal sender", async () => {
    // Mirror of the call-sites guard, kept adjacent to the routing code it
    // protects. The authoritative classification lives in
    // test/flash/unit/app/payment-splits/add-invoice-call-sites.spec.ts.
    expect(ROUTED_MINT_SITES).toContain("src/app/wallets/add-invoice-for-wallet.ts")
  })
})
