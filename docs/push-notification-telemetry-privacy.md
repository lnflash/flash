# Push notification telemetry privacy

This leaf is based on integrated backend `94d0090043ba8d454c9ce9779d3d3fa0872468ce`, including the preceding argument, GraphQL, HTTP, IBEX, Redis and ERP privacy boundaries. It requires those preceding source fixes; removing explicit push captures alone does not disable generic automatic argument capture. No real credential, provider request, exported span or deployment was used.

The multicast push boundary no longer logs device tokens or notification title/body/data. Individual Firebase failures produce fixed exception summaries and a closed messaging error code; unknown codes become `messaging/unknown-error`. Batch and topic logs contain only fixed operation/outcome text, known error codes and nonnegative integer counts bounded by the number of supplied tokens. SDK error messages, objects, response details, topic names and malformed count values cannot become diagnostic values through these paths.

`FirebaseMessageError` no longer JSON-serializes the SDK error and token. It retains the error class, a fixed message and a closed `failureCode`. The allowlist follows the pinned Firebase Admin SDK's `MessagingClientErrorCode` table; the existing application's fixed `messaging/quota-exceeded` diagnostic is retained. Unknown future provider codes require explicit review before they become telemetry metadata.

Token validation still supplies the exact token to Firebase with `dryRun: true`, returns false only for the known unregistered-token code and otherwise returns the same domain error class. Initialization failures no longer log raw credential/SDK errors. Topic subscriptions retain their existing fire-and-forget invocation and exact provider arguments, but now contain callback rejections locally so the process-level unhandled-rejection logger cannot serialize a private SDK error. This change adds no retry or delivery guarantee.

Delivery payloads and pruning behavior are preserved: multicast still receives the exact tokens, notification and data with dry-run disabled; only unregistered tokens are returned for removal; real success counts and known deduplicated failure codes remain available to callers. A zero-accepted batch still reports failure. Provider 500/502 detection remains local and produces the existing unreachable-error class with fixed text; other failures retain the unknown-error class with fixed text. Privacy validation does not change provider response or money-state semantics.

Integration review also closed the adjacent application logs for outcome,
Bridge KYC/withdrawal, referral and admin push paths. Those callers retain
their return/prune behavior, but emit fixed operation/outcome metadata instead
of raw returned errors, thrown provider errors or caller-supplied context.
Returned stale-token errors still carry exact tokens only to the pruning
function. A regression test exercises both returned and thrown private push
errors and checks that the log sink cannot receive their text.

Validation: 13 reviewed suites pass, **124 tests**, under Node 24 using the integration runner's fake `safeEnvironment`, network guard and disabled Watchman. Tests assert exact SDK input, stale-token pruning, APNs/sender failure codes, zero-delivery failure, admin refusal semantics, notification preferences, dry-run token validation, initialization containment, topic success/failure privacy and malformed provider diagnostics. All three TypeScript configurations, scoped ESLint and `git diff --check` pass.

This is a scoped source-boundary fix. Stale token arrays remain internal pruning data and must not be logged by future callers. It does not establish privacy for the separate multi-channel notifier, all application errors, explicitly attached account identifiers, historical records or collector retention. No assertion is made that every telemetry sink has been sanitized.
