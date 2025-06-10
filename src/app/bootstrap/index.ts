
import { createAdmin } from "./create-admin"
import { getAdminAccounts } from "@config"


export const bootstrap = async () => {
  getAdminAccounts().forEach(async (_) => createAdmin(_))
  
  // const adminAccountIds = await initialStaticAccountIds()

  // for (const accountNameString of Object.keys(adminAccountIds)) {
  //   const accountName = accountNameString as keyof InitialStaticAccountIds
  //   const accountId = adminAccountIds[accountName]
  //   if (!(accountId instanceof Error)) continue

  //   let adminConfig: AdminAccount | undefined = undefined
  //   switch (accountName) {
  //     case "bankOwnerAccountId":
  //       adminConfig = adminUsers.find((val) => val.role === "bankowner")
  //       break

  //     case "dealerBtcAccountId":
  //     case "dealerUsdAccountId":
  //       adminConfig = adminUsers.find((val) => val.role === "dealer")
  //       break

  //     case "funderAccountId":
  //       adminConfig = adminUsers.find((val) => val.role === "funder")
  //       break
  //   }
  //   if (adminConfig === undefined) {
  //     return new ConfigError("Missing required admin account config")
  //   }
}


// statusHistory: { $push: AccountStatus.Closed } }
