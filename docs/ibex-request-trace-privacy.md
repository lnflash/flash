# IBEX request trace privacy

This patch removes every `request.params` payload capture from `src/services/ibex/client.ts`. It is based on, and must be released with, telemetry commit `4921212ac`, which removes generic wrapper argument capture and GraphQL source export. Neither patch has been deployed by this task.

The receive-invoice, Lightning payment, onchain payment and static LNURL helpers previously serialized their completed provider request into a span attribute after adding `webhookSecret`. Ordinary calls therefore copied the configured webhook authentication secret into telemetry alongside account identifiers, invoices, memos and destinations. Removing generic wrapper argument capture did not prevent those explicit writes. Transaction history, crypto send, crypto requirement and crypto destination helpers also serialized their full input bodies or parameters.

All eight captures are removed. The existing fixed wrapper namespace and function name identify the operation; no input-derived replacement metadata is added. Required provider webhook authentication, URLs, amounts, expiry limits, request fields, response handling and payment execution remain unchanged. In particular, the webhook secret is still sent to the intended provider. Removing it from the provider body would break authentication rather than fix telemetry.

The focused mocked tests supply public fixture credentials and capture each of the eight SDK/HTTP calls and explicit telemetry entry points. They assert exact required provider bodies, webhook URLs/secrets, preserved response identity/data, and zero payload writes to tracing. Central wrapper privacy is verified by the separate tracing suites. The provider SDK, cache, HTTP and telemetry are mocked; no private environment, real provider call or exported span is used.

This patch does not sanitize error messages, provider error bodies, existing logs, HTTP instrumentation, Redis statements or other explicit trace attributes. `ibexFetch` and token-fetch error paths still need a separate review of provider-body logging and exception content. It does not establish that historical telemetry was scrubbed, revoke any previously exposed webhook credential or change collector configuration. Any historical credential-access/rotation work belongs to a separate coordinated operational action; no key was read or changed here.

Validation: 31 tests pass across the eight new adapter cases and both central tracing suites. All three TypeScript configurations, scoped ESLint and `git diff --check` pass with Node 24 and frozen-lock dependencies.
