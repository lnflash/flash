# Wallet-scoped transaction CSV

The public `ConsumerAccount.csvTransactions` and `BusinessAccount.csvTransactions`
fields require `walletIds: [WalletId!]!`. Before this change, both resolvers
ignored that argument and exported every stored wallet in the account. A
selected-wallet download could therefore contain transactions from other
wallets in the same account.

Both fields now require the authenticated account to match the source account
and pass the exact requested list to the application export service. That
service loads only stored wallets belonging to the account, rejects the entire
request if any requested ID is absent from that owned set, and uses the same
error for missing and foreign IDs. It deduplicates IDs in caller order. An empty
required list produces a header-only CSV and makes no IBEX transaction request.
Neither resolver expands a presented cash alias into an additional wallet ID.

The CSV export now opts into a strict transaction read: an IBEX error for any
selected wallet or a provider row that the existing transaction mapper cannot
represent aborts the download. A thrown provider error returns fixed export
failure text. Ordinary paginated history retains its prior partial-read
behavior. This removes the false success where a failed wallet could produce a
plausible but incomplete CSV.

This does **not** prove an exhaustive historical export. The existing IBEX
request uses `page: 0, limit: 0` without a continuation loop; the meaning of
`limit: 0` and large-history behavior still need provider acceptance. The
backend CSV writer also does not escape spreadsheet formulas. Native export
currently validates and escapes rows before sharing, but other consumers must
not treat this backend CSV as spreadsheet-safe. Those are separate release
checks. No provider call, account mutation or file download was made here.

Validation uses mocked repositories and IBEX plus the guarded Node 24 unit
runner. **14 tests in three focused suites** pass; the inherited **76 suites / 1,218 tests**
also pass. All three TypeScript configurations, ESLint, Typos and diff checks
pass. Tests cover exact owned subset/order, duplicate IDs, empty selection,
uniform missing/foreign refusal, caller/account mismatch, error propagation,
provider failure, unrepresentable rows and preservation of ordinary history.
