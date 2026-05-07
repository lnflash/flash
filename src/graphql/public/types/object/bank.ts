import { GT } from "@graphql/index"

const Bank = GT.Object({
  name: "Bank",
  fields: () => ({
    name: { type: GT.NonNull(GT.String) },
  }),
})

export default Bank
