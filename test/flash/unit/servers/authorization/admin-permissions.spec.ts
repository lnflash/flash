import { Rule, RuleOr } from "graphql-shield/typings/rules"

import {
  ADMIN_DEFAULT_ROLES,
  ADMIN_REVIEWER_ROLES,
  REVIEWER_MUTATION_FIELDS,
  REVIEWER_QUERY_FIELDS,
  buildAdminPermissionRules,
  roleMayAccess,
  rolesAllowedOn,
} from "@servers/authorization/admin-permissions"
import { ErpNextRoles } from "@services/frappe/Roles"

const queryFields = [
  "accountDetailsByUserPhone",
  "accountDetailsByUsername",
  "idDocumentReadUrl",
  "transactionsByHash",
]
const mutationFields = ["accountUpdateLevel", "accountUpdateStatus", "userUpdatePhone"]

// Evaluate a graphql-shield rule the way the middleware would, for a caller
// holding `roles`.
const evaluate = async (rule: Rule | RuleOr, roles: string[]) => {
  const ctx = { user: { userId: "u1", roles }, _shield: { cache: {} } }
  const info = { fieldName: "x", parentType: { name: "Query" } }
  return rule.resolve({}, {}, ctx as never, info as never, { debug: true } as never)
}

describe("admin permission allowlist", () => {
  it("defines the reviewer fields explicitly", () => {
    expect(REVIEWER_QUERY_FIELDS).toEqual([
      "accountDetailsByUserPhone",
      "idDocumentReadUrl",
    ])
    expect(REVIEWER_MUTATION_FIELDS).toEqual(["accountUpdateLevel"])
  })

  it("adds Flash Admin only on the reviewer fields", () => {
    expect(rolesAllowedOn("Query", "accountDetailsByUserPhone")).toBe(
      ADMIN_REVIEWER_ROLES,
    )
    expect(rolesAllowedOn("Query", "idDocumentReadUrl")).toBe(ADMIN_REVIEWER_ROLES)
    expect(rolesAllowedOn("Mutation", "accountUpdateLevel")).toBe(ADMIN_REVIEWER_ROLES)

    expect(rolesAllowedOn("Query", "accountDetailsByUsername")).toBe(ADMIN_DEFAULT_ROLES)
    expect(rolesAllowedOn("Mutation", "accountUpdateStatus")).toBe(ADMIN_DEFAULT_ROLES)
    expect(rolesAllowedOn("Mutation", "userUpdatePhone")).toBe(ADMIN_DEFAULT_ROLES)
    // a reviewer query name is not a reviewer mutation name and vice versa
    expect(rolesAllowedOn("Mutation", "idDocumentReadUrl")).toBe(ADMIN_DEFAULT_ROLES)
    expect(rolesAllowedOn("Query", "accountUpdateLevel")).toBe(ADMIN_DEFAULT_ROLES)
  })

  it("the default roles are unchanged and the reviewer set is a strict superset", () => {
    expect(ADMIN_DEFAULT_ROLES).toEqual([
      ErpNextRoles.SystemManager,
      ErpNextRoles.AccountsManager,
    ])
    expect(ADMIN_REVIEWER_ROLES).toEqual([
      ErpNextRoles.SystemManager,
      ErpNextRoles.AccountsManager,
      ErpNextRoles.FlashAdmin,
    ])
  })

  it("roleMayAccess: Flash Admin passes the reviewer fields and nothing else", () => {
    const flashAdmin = [ErpNextRoles.FlashAdmin]
    expect(
      roleMayAccess({
        kind: "Query",
        field: "accountDetailsByUserPhone",
        roles: flashAdmin,
      }),
    ).toBe(true)
    expect(
      roleMayAccess({ kind: "Query", field: "idDocumentReadUrl", roles: flashAdmin }),
    ).toBe(true)
    expect(
      roleMayAccess({ kind: "Mutation", field: "accountUpdateLevel", roles: flashAdmin }),
    ).toBe(true)

    expect(
      roleMayAccess({
        kind: "Mutation",
        field: "accountUpdateStatus",
        roles: flashAdmin,
      }),
    ).toBe(false)
    expect(
      roleMayAccess({ kind: "Mutation", field: "userUpdatePhone", roles: flashAdmin }),
    ).toBe(false)
    expect(
      roleMayAccess({
        kind: "Query",
        field: "accountDetailsByUsername",
        roles: flashAdmin,
      }),
    ).toBe(false)
    expect(
      roleMayAccess({ kind: "Query", field: "transactionsByHash", roles: flashAdmin }),
    ).toBe(false)
  })

  it("roleMayAccess: System Manager / Accounts Manager pass everything; no role passes nothing", () => {
    for (const role of [ErpNextRoles.SystemManager, ErpNextRoles.AccountsManager]) {
      expect(
        roleMayAccess({ kind: "Mutation", field: "accountUpdateStatus", roles: [role] }),
      ).toBe(true)
      expect(
        roleMayAccess({ kind: "Mutation", field: "accountUpdateLevel", roles: [role] }),
      ).toBe(true)
    }
    expect(
      roleMayAccess({ kind: "Mutation", field: "accountUpdateLevel", roles: [] }),
    ).toBe(false)
    expect(
      roleMayAccess({ kind: "Mutation", field: "accountUpdateLevel", roles: ["Guest"] }),
    ).toBe(false)
  })
})

describe("buildAdminPermissionRules", () => {
  const rules = buildAdminPermissionRules({ queryFields, mutationFields })

  it("covers every authed field", () => {
    expect(Object.keys(rules.Query).sort()).toEqual([...queryFields].sort())
    expect(Object.keys(rules.Mutation).sort()).toEqual([...mutationFields].sort())
  })

  it("Flash Admin passes on the allowlisted fields", async () => {
    const roles = [ErpNextRoles.FlashAdmin]
    await expect(evaluate(rules.Query.accountDetailsByUserPhone, roles)).resolves.toBe(
      true,
    )
    await expect(evaluate(rules.Query.idDocumentReadUrl, roles)).resolves.toBe(true)
    await expect(evaluate(rules.Mutation.accountUpdateLevel, roles)).resolves.toBe(true)
  })

  it("Flash Admin is denied on a non-allowlisted mutation and query", async () => {
    const roles = [ErpNextRoles.FlashAdmin]
    await expect(evaluate(rules.Mutation.accountUpdateStatus, roles)).resolves.not.toBe(
      true,
    )
    await expect(evaluate(rules.Mutation.userUpdatePhone, roles)).resolves.not.toBe(true)
    await expect(evaluate(rules.Query.accountDetailsByUsername, roles)).resolves.not.toBe(
      true,
    )
  })

  it("System Manager and Accounts Manager keep access everywhere", async () => {
    for (const role of [ErpNextRoles.SystemManager, ErpNextRoles.AccountsManager]) {
      await expect(evaluate(rules.Mutation.accountUpdateStatus, [role])).resolves.toBe(
        true,
      )
      await expect(evaluate(rules.Mutation.accountUpdateLevel, [role])).resolves.toBe(
        true,
      )
      await expect(evaluate(rules.Query.transactionsByHash, [role])).resolves.toBe(true)
    }
  })

  it("a caller with no recognized role is denied everywhere", async () => {
    await expect(evaluate(rules.Query.idDocumentReadUrl, ["Guest"])).resolves.not.toBe(
      true,
    )
    await expect(evaluate(rules.Mutation.accountUpdateLevel, [])).resolves.not.toBe(true)
  })

  it("per-field overrides win over the allowlist", async () => {
    const onlySystemManager = buildAdminPermissionRules({
      queryFields,
      mutationFields,
      mutationRoleOverrides: {
        accountUpdateLevel: rules.Mutation.accountUpdateStatus as Rule,
      },
    })
    expect(onlySystemManager.Mutation.accountUpdateLevel).toBe(
      rules.Mutation.accountUpdateStatus,
    )
  })
})
