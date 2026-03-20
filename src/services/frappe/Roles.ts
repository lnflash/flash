export const ErpNextRoles = {
  AccountsManager: "Accounts Manager",
  SystemManager: "System Manager",
} as const

export type ErpNextRole = (typeof ErpNextRoles)[keyof typeof ErpNextRoles]
