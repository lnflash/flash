import { GT } from "@graphql/index"
import Timestamp from "@graphql/shared/types/scalar/timestamp"

// ENG-889: a hold on an account's cash-outs, as ops see it. Never exposed on
// the public API: the account holder is only told cash-out is unavailable.
const CashoutHold = GT.Object<AccountCashoutHold>({
  name: "CashoutHold",
  fields: () => ({
    reason: { type: GT.NonNull(GT.String) },
    source: {
      type: GT.NonNull(GT.String),
      description:
        'What placed the hold: "bridge-customer-status" (the watcher) or "admin" (accountPlaceCashoutHold, with setByUserId).',
    },
    setAt: { type: GT.NonNull(Timestamp) },
    setByUserId: { type: GT.ID },
  }),
})

export default CashoutHold
