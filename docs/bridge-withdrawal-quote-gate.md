# Bridge withdrawal quote and consent gate

The existing two-step GraphQL flow stores a pending withdrawal before calling
Bridge. RN then queries that row and confirms by ID. The pinned RN confirmation
screen calculates a fixed 0.5% fee locally from `withdrawal.amount`; the backend
stores a configured Flash developer fee plus estimated Bridge and gas fees from
a changing market snapshot. No confirmation input binds the reviewed amount,
wallet, bank, fee total, or quote expiry. This is not an immutable reviewed
payment quote, and native withdrawal initiation remains closed.

This backend hardening keeps the first persisted fee snapshot on a pending
request. Retrying the same account/destination/amount no longer refreshes that
snapshot underneath an open confirmation screen. An old pending row missing a
complete estimate now refuses before transfer creation and can be cancelled
and requested anew. Initiation independently refuses malformed/non-USDT rows,
missing or fee-consuming estimates, and external accounts that are no longer
verified. The direct service entry point also refuses malformed amount strings.
The service parses up to six USDT decimal places into exact microunits and
refuses amounts above one billion USDT, a defensive representability bound
rather than a business transaction limit.
These checks do not prove that a client displayed or accepted the estimate.

The Bridge transfer receipt's `amount` and `currency` can describe the payout,
while the IBEX USDT debit uses the original pending `amount`. Bridge's official
[orchestration overview](https://www.withbridge.com/product/orchestration)
describes determining the source amount needed for a destination amount; it
does not supply an executable debit cap or a frozen provider quote in this
repository. The current code still writes the returned transfer amount/currency
over the pending amount/currency after creation. Before enabling native
withdrawal, establish source and destination units with a sandbox transfer,
persist them separately, and verify the source debit against a user-approved
maximum. Also add a short server-enforced quote expiry and a confirmation
contract that echoes the exact reviewed amount, source wallet, bank and fee
bound. Do not infer fee consent from the existence of a pending row.

A timeout during `createTransfer` can occur after Bridge created a transfer but
before Mongo recorded its ID. The same pending ID derives a stable idempotency
key, but this repository has no proven provider retention window or lookup by
that key. Do not treat a retry or a missing local transfer ID as proof no
transfer exists. Operational recovery requires authoritative Bridge evidence
or a durable creation-uncertainty fence before automatic retry. The existing
IBEX send uncertainty fence starts later, after a transfer ID is recorded.

No live Bridge or IBEX call was used for this audit or its focused tests.
