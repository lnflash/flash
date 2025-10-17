import { GT } from "@graphql/index"
import { InviteStatus as DomainInviteStatus } from "@services/mongoose/models/invite"

const InviteStatus = GT.Enum({
  name: "InviteStatus",
  values: {
    PENDING: { value: DomainInviteStatus.PENDING },
    SENT: { value: DomainInviteStatus.SENT },
    ACCEPTED: { value: DomainInviteStatus.ACCEPTED },
    EXPIRED: { value: DomainInviteStatus.EXPIRED },
  },
})

export default InviteStatus