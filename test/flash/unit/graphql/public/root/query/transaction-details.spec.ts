const mockGetTransactionDetailsForAccount = jest.fn()
const mockGetTransactionDetailsById = jest.fn()
jest.mock("@app", () => ({
  Wallets: {
    getTransactionDetailsForAccount: (...a: unknown[]) =>
      mockGetTransactionDetailsForAccount(...a),
    getTransactionDetailsById: (...a: unknown[]) => mockGetTransactionDetailsById(...a),
  },
}))

import { CouldNotFindTransactionError } from "@domain/ledger"
import TransactionDetailsQuery from "@graphql/public/root/query/transaction-details"

type Payload = { errors: { message: string }[]; transactionDetails?: unknown }

const resolveQuery = (accountId: string, transactionId: string): Promise<Payload> => {
  const query = TransactionDetailsQuery as unknown as {
    resolve: (
      source: null,
      args: { input: { transactionId: string } },
      context: unknown,
      info: never,
    ) => Promise<Payload>
  }
  return query.resolve(
    null,
    { input: { transactionId } },
    { domainAccount: { id: accountId } },
    undefined as never,
  )
}

describe("transactionDetails (public)", () => {
  beforeEach(() => jest.clearAllMocks())

  it("scopes the lookup to the calling account, never the unscoped admin lookup", async () => {
    mockGetTransactionDetailsForAccount.mockResolvedValue({ id: "tx-1", accountId: "w1" })

    const result = await resolveQuery("acct-1", "tx-1")

    expect(mockGetTransactionDetailsForAccount).toHaveBeenCalledWith({
      accountId: "acct-1",
      transactionId: "tx-1",
    })
    expect(mockGetTransactionDetailsById).not.toHaveBeenCalled()
    expect(result).toEqual({
      errors: [],
      transactionDetails: { id: "tx-1", accountId: "w1" },
    })
  })

  it("returns an error and no details for a transaction the caller doesn't own", async () => {
    mockGetTransactionDetailsForAccount.mockResolvedValue(
      new CouldNotFindTransactionError(),
    )

    const result = await resolveQuery("acct-1", "someone-elses-tx")

    expect(result.transactionDetails).toBeUndefined()
    expect(result.errors).toHaveLength(1)
  })
})
