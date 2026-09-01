export const ErpNextRoles = {
  AccountsManager: "Accounts Manager",
  SystemManager: "System Manager",
  // ERPNext reviewers who work the Account Upgrade Request / ID Verification
  // queue. Granted only on the admin fields that flow needs — see
  // src/servers/authorization/admin-permissions.ts.
  FlashAdmin: "Flash Admin",
} as const

export type ErpNextRole = (typeof ErpNextRoles)[keyof typeof ErpNextRoles]
