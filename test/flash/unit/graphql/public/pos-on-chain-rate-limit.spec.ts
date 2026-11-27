import { graphql, GraphQLObjectType, GraphQLSchema } from "graphql"
import { CheckoutError, checkoutService } from "@app/pos-on-chain/checkout"
import { posOnChainFields } from "@graphql/public/pos-on-chain/fields"

const getService = jest.fn<ReturnType<typeof checkoutService> | null, []>()
const consume = jest.fn<Promise<void>, [string, string]>()
const fields = posOnChainFields(getService, consume)
const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: "Query",
    fields: { supported: fields.supported, status: fields.status },
  }),
  mutation: new GraphQLObjectType({
    name: "Mutation",
    fields: { create: fields.create },
  }),
})

beforeEach(() => {
  getService.mockReset()
  consume.mockReset()
})

it.each([
  ["supported", "{ supported }"],
  [
    "create",
    'mutation { create(input: {recipientWalletId:"merchant", requestId:"ref", sats:800}) { errors { message } } }',
  ],
  ["status", '{ status(id:"ref") { errors { message } } }'],
])("limits %s before accessing checkout services", async (operation, source) => {
  consume.mockRejectedValue(new CheckoutError("Too many checkout requests."))
  const result = await graphql({ schema, source, contextValue: { ip: "192.0.2.15" } })
  expect(consume).toHaveBeenCalledWith("192.0.2.15", operation)
  expect(JSON.stringify(result)).toContain("Too many checkout requests.")
  expect(getService).not.toHaveBeenCalled()
})

it("charges each availability field even when the client IP is unknown", async () => {
  consume.mockResolvedValue(undefined)
  getService.mockReturnValue(null)
  const result = await graphql({
    schema,
    source: "{ a:supported b:supported }",
    contextValue: {},
  })
  expect(result.data).toEqual({ a: false, b: false })
  expect(consume.mock.calls).toEqual([
    ["unknown", "supported"],
    ["unknown", "supported"],
  ])
})

describe("create arguments", () => {
  const walletId = "6c4b4a0b-5d3c-4c2a-9f6e-0d8c1b2a3e4f"
  const createCheckout = jest.fn()
  const run = (input: string) =>
    graphql({
      schema,
      source: `mutation { create(input: {${input}}) { checkout { address sats } errors { message } } }`,
      contextValue: { ip: "192.0.2.15" },
    })

  beforeEach(() => {
    consume.mockResolvedValue(undefined)
    createCheckout.mockReset()
    getService.mockReturnValue({
      create: createCheckout,
    } as unknown as ReturnType<typeof checkoutService>)
  })

  it("refuses an invalid wallet id with the scalar's message, after charging the IP", async () => {
    const result = await run(`recipientWalletId:"merchant", requestId:"ref", sats:800`)
    expect(result.data?.create).toEqual({
      checkout: null,
      errors: [{ message: "Invalid value for WalletId" }],
    })
    expect(consume).toHaveBeenCalledWith("192.0.2.15", "create")
    expect(createCheckout).not.toHaveBeenCalled()
  })

  it("refuses a fractional sat amount at the schema", async () => {
    const result = await run(
      `recipientWalletId:"${walletId}", requestId:"ref", sats:800.5`,
    )
    expect(JSON.stringify(result)).toContain("Invalid type for SatAmount")
    expect(createCheckout).not.toHaveBeenCalled()
  })

  it("passes the caller's IP to the service for its per-merchant budget", async () => {
    createCheckout.mockResolvedValue({ address: "tb1qexample", sats: 800 })
    const result = await run(`recipientWalletId:"${walletId}", requestId:"ref", sats:800`)
    expect(result.data?.create).toEqual({
      checkout: { address: "tb1qexample", sats: 800 },
      errors: [],
    })
    expect(createCheckout).toHaveBeenCalledWith(
      { recipientWalletId: walletId, requestId: "ref", sats: 800 },
      "192.0.2.15",
    )
  })
})
