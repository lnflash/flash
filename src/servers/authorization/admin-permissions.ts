import { or, rule } from "graphql-shield"
import { Rule, RuleOr } from "graphql-shield/typings/rules"

import { AuthorizationError } from "@graphql/error"
import { baseLogger } from "@services/logger"
import { ErpNextRole, ErpNextRoles } from "@services/frappe/Roles"

const graphqlLogger = baseLogger.child({ module: "graphql" })

export const hasRole = (role: ErpNextRole) =>
  rule({ cache: "contextual" })((parent, args, ctx: GraphQLAdminContext) => {
    return ctx.user.roles.includes(role)
      ? true
      : new AuthorizationError({ logger: graphqlLogger })
  })

// Roles allowed on every admin field.
export const ADMIN_DEFAULT_ROLES: readonly ErpNextRole[] = [
  ErpNextRoles.SystemManager,
  ErpNextRoles.AccountsManager,
]

// Roles allowed on the ID-verification reviewer fields only. ERPNext
// reviewers who hold just "Flash Admin" need exactly three fields to complete
// an Account Upgrade Request approval: look the account up by phone, read the
// ID document, and set the level. Everything else stays on the default rule
// (docs/id-verification.md, "Roles").
export const ADMIN_REVIEWER_ROLES: readonly ErpNextRole[] = [
  ...ADMIN_DEFAULT_ROLES,
  ErpNextRoles.FlashAdmin,
]

export const REVIEWER_QUERY_FIELDS: readonly string[] = [
  "accountDetailsByUserPhone",
  "idDocumentReadUrl",
]

export const REVIEWER_MUTATION_FIELDS: readonly string[] = ["accountUpdateLevel"]

export type AdminFieldKind = "Query" | "Mutation"

export const isReviewerField = (kind: AdminFieldKind, field: string): boolean =>
  kind === "Query"
    ? REVIEWER_QUERY_FIELDS.includes(field)
    : REVIEWER_MUTATION_FIELDS.includes(field)

// The roles that may call a given admin field. Pure — the shield below is
// derived from it, and tests exercise it directly.
export const rolesAllowedOn = (
  kind: AdminFieldKind,
  field: string,
): readonly ErpNextRole[] =>
  isReviewerField(kind, field) ? ADMIN_REVIEWER_ROLES : ADMIN_DEFAULT_ROLES

export const roleMayAccess = ({
  kind,
  field,
  roles,
}: {
  kind: AdminFieldKind
  field: string
  roles: readonly string[]
}): boolean => rolesAllowedOn(kind, field).some((role) => roles.includes(role))

export type AdminPermissionRules = {
  Query: { [field: string]: Rule | RuleOr }
  Mutation: { [field: string]: Rule | RuleOr }
}

// Build the graphql-shield rule map for the admin schema. `queryFields` and
// `mutationFields` are the authed field maps from @graphql/admin. Per-field
// overrides (tighter than the default) win over the allowlist.
export const buildAdminPermissionRules = ({
  queryFields,
  mutationFields,
  mutationRoleOverrides = {},
}: {
  queryFields: readonly string[]
  mutationFields: readonly string[]
  mutationRoleOverrides?: { [field: string]: Rule }
}): AdminPermissionRules => {
  const defaultRule = or(...ADMIN_DEFAULT_ROLES.map(hasRole))
  const reviewerRule = or(...ADMIN_REVIEWER_ROLES.map(hasRole))

  const ruleFor = (kind: AdminFieldKind, field: string) =>
    isReviewerField(kind, field) ? reviewerRule : defaultRule

  const Query: AdminPermissionRules["Query"] = {}
  for (const field of queryFields) {
    Query[field] = ruleFor("Query", field)
  }

  const Mutation: AdminPermissionRules["Mutation"] = {}
  for (const field of mutationFields) {
    Mutation[field] = mutationRoleOverrides[field] ?? ruleFor("Mutation", field)
  }

  return { Query, Mutation }
}
