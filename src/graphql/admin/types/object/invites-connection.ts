import { connectionDefinitions } from "@graphql/connections"
import AdminInvite from "./admin-invite"

export const { connectionType: InvitesConnection } = connectionDefinitions({
  nodeType: AdminInvite,
  name: "Invites",
})

export default InvitesConnection