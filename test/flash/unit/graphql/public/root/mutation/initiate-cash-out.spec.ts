// ENG-695: initiateCashout answers a second execution of the same offer with a
// typed OFFER_ALREADY_EXECUTED error the client can branch on, not the generic
// server error, and keeps it out of the Critical exception stream.

const mockExecuteCashout = jest.fn()
const mockRecordException = jest.fn()

jest.mock("@app/offers/CashoutManager", () => ({
  __esModule: true,
  default: {
    executeCashout: (...args: unknown[]) => mockExecuteCashout(...args),
  },
}))

jest.mock("@config", () => ({
  Cashout: { Enabled: true },
  // read at module load by @graphql/error
  getOnChainWalletConfig: () => ({ dustThreshold: 546 }),
}))

jest.mock("@services/tracing", () => ({
  recordExceptionInCurrentSpan: (...args: unknown[]) => mockRecordException(...args),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { OfferAlreadyExecuted, OfferNotFound } from "@domain/cache"
import { ErrorLevel } from "@domain/shared"
import { InternalServerError } from "@graphql/error"
import InitiateCashoutMutation from "@graphql/public/root/mutation/offers/initiate-cash-out"

const offerId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const walletId = "11111111-1111-4111-8111-111111111111"
const accountId = "64df1a2b3c4d5e6f78901234" as AccountId
const context = { domainAccount: { id: accountId } }

type Resolvable = {
  resolve: (
    source: unknown,
    args: { input: Record<string, unknown> },
    context: unknown,
    info: never,
  ) => Promise<unknown>
}

const initiateCashout = () =>
  (InitiateCashoutMutation as unknown as Resolvable).resolve(
    null,
    { input: { offerId, walletId } },
    context,
    {} as never,
  )

describe("initiateCashout resolver", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns the cashout id when the offer executes", async () => {
    mockExecuteCashout.mockResolvedValue({ cashoutId: "ACC-CSH-2026-00001" })

    const result = await initiateCashout()

    expect(mockExecuteCashout).toHaveBeenCalledWith(offerId, walletId, accountId)
    expect(result).toEqual({ errors: [], id: "ACC-CSH-2026-00001" })
    expect(mockRecordException).not.toHaveBeenCalled()
  })

  it("returns OFFER_ALREADY_EXECUTED and no id when the offer was already executed", async () => {
    mockExecuteCashout.mockResolvedValue(new OfferAlreadyExecuted())

    const result = await initiateCashout()

    expect(result).toEqual({
      errors: [
        expect.objectContaining({
          code: "OFFER_ALREADY_EXECUTED",
          message: "This offer has already been used. Request a new cashout offer.",
        }),
      ],
      id: null,
    })
    expect(mockRecordException).not.toHaveBeenCalled()
  })

  // Pins the unchanged catch-all for every other failure. Turning those into
  // typed { errors, id } payloads is a separate follow-up, not ENG-695.
  it("keeps every other failure on the generic server-error path", async () => {
    const notFound = new OfferNotFound()
    mockExecuteCashout.mockResolvedValue(notFound)

    const result = await initiateCashout()

    expect(result).toBeInstanceOf(InternalServerError)
    expect(mockRecordException).toHaveBeenCalledWith(
      expect.objectContaining({ error: notFound, level: ErrorLevel.Critical }),
    )
  })
})
