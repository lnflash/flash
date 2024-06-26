import { GT } from "@graphql/index"

import EndpointId from "../scalar/endpoint-id"
import EndpointUrl from "../scalar/endpoint-url"

const CallbackEndpoint = GT.Object({
  name: "CallbackEndpoint",
  fields: () => ({
    id: {
      type: GT.NonNull(EndpointId),
    },
    url: {
      type: GT.NonNull(EndpointUrl),
    },
  }),
})

export default CallbackEndpoint
