import { GT } from "@graphql/index"
import IError from "@graphql/shared/types/abstract/error"

const ServiceTokenPayload = GT.Object({
  name: "ServiceTokenPayload",
  fields: () => ({
    errors: {
      type: GT.NonNullList(IError),
    },
    token: {
      type: GT.Scalar({ name: "AuthToken" }),
    },
  }),
})

export default ServiceTokenPayload