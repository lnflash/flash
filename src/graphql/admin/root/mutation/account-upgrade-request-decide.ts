import { Admin } from "@app"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { GT } from "@graphql/index"
import SuccessPayload from "@graphql/shared/types/payload/success-payload"

const AccountUpgradeRequestDecideInput = GT.Input({
  name: "AccountUpgradeRequestDecideInput",
  fields: () => ({
    requestName: {
      type: GT.NonNull(GT.String),
      description: "ERPNext document name of the upgrade request",
    },
    approve: {
      type: GT.NonNull(GT.Boolean),
      description: "True to approve, false to reject",
    },
  }),
})

const AccountUpgradeRequestDecideMutation = GT.Field<
  null,
  GraphQLAdminContext,
  {
    input: {
      requestName: string
      approve: boolean
    }
  }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(SuccessPayload),
  args: {
    input: { type: GT.NonNull(AccountUpgradeRequestDecideInput) },
  },
  resolve: async (_, args) => {
    const { requestName, approve } = args.input

    const result = await Admin.decideUpgradeRequest({ requestName, approve })

    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)], success: false }
    }

    return { errors: [], success: true }
  },
})

export default AccountUpgradeRequestDecideMutation
