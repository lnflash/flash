import { GT } from "@graphql/index"

const Address = GT.Object({
  name: "Address",
  fields: () => ({
    title: { type: GT.NonNull(GT.String) },
    line1: { type: GT.NonNull(GT.String) },
    line2: { type: GT.String },
    city: { type: GT.NonNull(GT.String) },
    state: { type: GT.NonNull(GT.String) },
    postalCode: { type: GT.String },
    country: { type: GT.NonNull(GT.String) },
  }),
})

export default Address
