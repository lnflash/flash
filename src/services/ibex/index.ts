import client from "./client"
import webhookServer from "./webhook-server"

// https://docs.ibexmercado.com/reference/get-transaction-details
// Would be nice to have this in the codegen sdk
const OnchainStatus = {
  Initiated: { id: 1, name: "INITIATED" },
  Mempool: { id:2, name: "MEMPOOL" },
  Blockchain: { id: 3, name: "BLOCKCHAIN" },
  Confirmed: { id: 4, name: "CONFIRMED" },
  Failed: { id: 5, name: "FAILED" },
} as const

export {
    client,
    webhookServer,
    OnchainStatus
}
