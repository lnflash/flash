# Private IBEX custom-fetch failures

The custom IBEX crypto/account fetch path previously logged the full URL and
provider response body, then placed both the path and body in an `IbexError`.
Paths can contain account IDs; provider bodies can echo credentials and payment
details. The adjacent OAuth-token request also put a failed response body in
its returned error.

Failed HTTP responses now produce fixed error text with the numeric HTTP status
only. The crypto/account path logs a fixed operation and outcome plus that
status. Neither failure path reads the response body. Success requests and
response parsing, authentication headers, provider payloads, return types and
HTTP failure classification remain unchanged.

Mocked regressions cover an account ID in the path, a destination handle, a
private provider response, and a failed OAuth-token response. They assert that
logs, returned errors and spans contain none of those values, while the numeric
status remains available. The guarded telemetry selection passes 17 suites and
332 tests; the whole-tree TypeScript checks, scoped ESLint and diff check pass.
No live IBEX request or financial mutation was made.

This is a privacy fix, not payment-outcome reconciliation. In the existing
Bridge withdrawal flow, a crypto-send failure response is still marked as a
failed send; the provider could have debited funds before an ambiguous reply.
That money-state boundary requires separate provider and reconciliation work
before relying on it as a definitive retry signal.
