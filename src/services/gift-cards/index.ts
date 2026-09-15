// Barrel. Importing this module registers every adapter with the registry.
// Adapters expose an idempotent `register*Provider()`; calling them here keeps
// the registry free of vendor knowledge while satisfying import/no-unassigned-import.
import { registerBitcoinCompanyProvider } from "./bitcoin-company"

registerBitcoinCompanyProvider()

export * from "./registry"
