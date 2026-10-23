# Earn reward safety prerequisites

Audited against backend `7402dd7fcf49e378e4af5189232dffb76a4564d5`.
These changes require a later backend deployment to affect clients. No payout
provider was contacted to develop or test them.

## Concrete behavior changes

Previously, `RewardsRepository.add` used an unconditional `$push` and inspected
the pre-update document afterward. A repeated claim returned
`RewardAlreadyPresentError` **after appending another marker**. It now uses
`$addToSet` with an explicit pre-update return. The single-document atomic
operation gives one winner for a previously absent lesson; replays return the
existing error without adding duplicates. Historical duplicates are preserved;
this is not a data repair or proof of a prior payout.

Previously, `addEarn` claimed eligibility before invoking the BTC send wrapper.
That wrapper ultimately uses the USD/USDT-only `usdWalletAmountFromInput`, which
rejects BTC. Thus an eligible BTC lesson could be marked completed even though
the payment predictably failed before contacting IBEX. The same adapter now
runs before claiming. **The current BTC reward rail remains unavailable**, with
its existing `UnsupportedCurrencyError`; failed preflight leaves the lesson
eligible. No BTC amount is reinterpreted as cents.

Funding must resolve to an existing checking BTC wallet owned by an active
funding account. The recipient must have a checking BTC wallet owned by its
active account. External SDK wallet records are not eligible destinations for
this IBEX account-ID send path. A missing funding resolver returns a controlled
repository error. Existing phone/IP authorization remains required. Only own
properties of the configured lesson catalog are accepted as lesson IDs.

If a supported payout rail is implemented later, a non-error `pending`,
`failed`, or `already_paid` result does not produce a successful completion
acknowledgement. Only an explicit success value does. The reward marker is not
rolled back after an attempted payout: a timeout or pending outcome may have
spent funds, so making the lesson eligible again could duplicate a payment.

## Remaining protocol work before enabling native reward claims

These prerequisites do not implement durable payment settlement or SDK reward
delivery. The current `account.earn` array and `quiz.completed` projection are
claim markers, not authoritative receipts. Existing burned markers require a
separate evidence-based reconciliation; do not bulk reset or infer payment from
the marker. The native learning flow must keep reward completion unavailable.

A deployable SDK reward protocol needs:

1. Separate lesson progress from reward claim/settlement status. Persist a
   unique `(accountId, lessonId)` reward claim with an immutable client request
   key and explicit eligible, reserved, pending, paid, and failed states.
2. Validate eligibility, reward amount, funding rail/currency and available
   funding before reservation. A preflight balance read cannot reserve funds:
   provider/ledger debit enforcement and a durable claim are still required.
3. For SDK BTC delivery, accept a fresh wallet-generated fixed-amount BOLT11
   invoice. Bind its verified hash, network, exact reward amount, signature and
   expiry to the authorized account and lesson. A local external wallet UUID
   must never be sent as an IBEX account ID.
4. Persist the immutable invoice and payment attempt before contacting the
   provider; permit one worker through an atomic state transition. Preserve
   unknown outcomes for reconciliation rather than paying a new invoice or
   generating a new attempt on retry. Provider idempotency and payment lookup
   capabilities must be verified before enabling dispatch.
5. Expose an authenticated reward-status read with settlement identity and
   authoritative provider evidence. A lesson-completed boolean or payment
   submission acknowledgement must not claim that SDK funds were received.

The current send helper and funding architecture are deliberately unchanged;
no unsupported BTC adapter or external-SDK dispatch is enabled by this patch.

## Offline verification

`test/flash/unit/services/mongoose/rewards.spec.ts` models serialized Mongo
atomic preimages and applies the requested update operator. Twelve concurrent
claims yield one success, eleven duplicate errors, and one stored marker;
replays, historical duplicates, missing accounts, and database errors are
covered. This mocked test is not a live Mongo concurrency integration test.

`test/flash/unit/app/payments/add-earn.spec.ts` uses the real current BTC amount
adapter with mocked repositories and send boundary. Preflight failures must
invoke neither the claim nor the send. Explicitly mocked future adapter success
exercises duplicate claims, payment errors, non-settled statuses and success
without enabling a production payout rail or making network requests.

Run directly with Node 24 and the repository Jest config, without sourcing
`.env` or invoking provider services:

```sh
node node_modules/jest/bin/jest.js --config test/flash/unit/jest.config.js \
  --runInBand --runTestsByPath \
  test/flash/unit/services/mongoose/rewards.spec.ts \
  test/flash/unit/app/payments/add-earn.spec.ts
```
