import { GT } from "@graphql/index"
import IError from "@graphql/shared/types/abstract/error"
import AuthToken from "@graphql/shared/types/scalar/auth-token"

const ServiceTokenPayload = GT.Object({
  name: "ServiceTokenPayload",
  fields: () => ({
    errors: {
      type: GT.NonNullList(IError),
    },
    token: {
      type: AuthToken,
    },
  }),
})

export default ServiceTokenPayload