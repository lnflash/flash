import { GT } from "@graphql/index"
import { InviteMethod as DomainInviteMethod } from "@services/mongoose/models/invite"

const InviteMethod = GT.Enum({
  name: "InviteMethod",
  values: {
    EMAIL: { value: DomainInviteMethod.EMAIL },
    SMS: { value: DomainInviteMethod.SMS },
    WHATSAPP: { value: DomainInviteMethod.WHATSAPP },
  },
})

export default InviteMethod