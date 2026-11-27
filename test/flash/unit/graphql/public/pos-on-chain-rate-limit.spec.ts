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
