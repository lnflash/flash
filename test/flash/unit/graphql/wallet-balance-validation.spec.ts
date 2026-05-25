import { parse, validate } from "graphql"

import { gqlMainSchema } from "@graphql/public"

describe("wallet balance query validation", () => {
  it("allows querying USD and USDT wallet balances with the same response name", () => {
    const query = parse(`
      query Me {
        me {
          defaultAccount {
            wallets {
              ... on UsdtWallet {
                id
                balance
              }
              ... on UsdWallet {
                id
                balance
              }
            }
          }
        }
      }
    `)

    const errors = validate(gqlMainSchema, query)

    expect(errors).toEqual([])
  })
})
