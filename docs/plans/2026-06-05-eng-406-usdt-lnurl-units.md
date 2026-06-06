# Fix USDT LNURL-pay Amount Units

> **ENG-406** — Fix USDT LNURL-pay amount units for Flash Lightning Address edge case

## Overview

The IBEX LNURL-pay API (`POST /v2/lnurl/pay/send`) expects the `amount` field in **millisatoshis**, but the `payToLnurl` wrapper was passing `args.send.amount` directly — the wallet currency's base unit (USDT micros, USD cents, or BTC sats).

## Root Cause

`src/services/ibex/client.ts:255` — `payToLnurl` passed `args.send.amount` directly to `Ibex.payToLnurl()`. The `args.send` was of type `IbexCurrency` (`{ amount: number, currencyId: IbexCurrencyId }`), and for USDT wallets `amount` is USDT micros (~10,000 per USD cent), not millisatoshis.

## Fix

**Interface change** — `src/services/ibex/index.types.d.ts`:
- Replaced `send: IbexCurrency` with `amountMsat: number` on `PayLnurlArgs`

**Call-site change** — `src/services/ibex/client.ts`:
- Changed `amount: args.send.amount` → `amount: args.amountMsat`

## Rationale

- The field name `amountMsat` makes the expected unit unambiguous
- Conversion from wallet currency → msats requires the DealerPriceService (app layer), not available in the services layer
- Callers are forced to perform explicit conversion, preventing silent unit bugs
- `PayLnurlArgs` is only used by `payToLnurl` — no other callers to break

## Remaining Work

- Wire up a GraphQL mutation that calls `payToLnurl` with proper MSAT conversion (ENG-406 follow-up) — completed in the follow-up implementation described below
- Authored by: Vandana

## Implementation Status

Implemented locally on `eng-274/sandbox-e2e-plan`:

- Strengthened `PayLnurlArgs.amountMsat` from raw `number` to branded `MilliSatoshis`.
- Added `src/app/payments/lnurl-pay.ts` with USD/USDT wallet amount conversion, whole-satoshi msat generation, IBEX int32 validation, and LNURL `minSendable` / `maxSendable` validation.
- Added `InvalidLnurlAmountError` and mapped it to the existing GraphQL LNURL validation error surface.
- Added wallet-level public GraphQL mutation `lnurlPaymentSend`.
- Registered the mutation in `src/graphql/public/mutations.ts`.
- Regenerated `src/graphql/public/schema.graphql` and `dev/apollo-federation/supergraph.graphql`.
- Added focused unit tests for the conversion helper and mutation resolver.

Verification:

- `yarn test:unit --testPathPattern=app/payments/lnurl-pay.spec.ts` — passed.
- `yarn test:unit --testPathPattern=graphql/public/root/mutation/lnurl-payment-send.spec.ts` — passed.
- `npx prettier --check ...` on touched files — passed.
- `npx tsc --noEmit --skipLibCheck` — no ENG-406 source/test errors after fixes; still fails on pre-existing unrelated test type errors in offers, cash-wallet history resolver specs, and Bridge webhook/reconciliation specs.
- `yarn check:sdl` — wrote schemas and composed the supergraph, then failed because `src/graphql/public/schema.graphql` had expected generated changes to commit.

---

## Dual-Model Review Follow-Up

The wrapper fix is correct, but the follow-up wiring needs more detail before implementation:

- `amountMsat: number` is clearer than `send: IbexCurrency`, but a branded `MilliSatoshis` type is safer than a raw number.
- IBEX's LNURL-pay request field is named `amount`, but the unit is millisatoshis.
- IBEX documents the field as `int32`, so the plan must reject values above `2_147_483_647` msats before calling IBEX.
- Wallet compatibility requires whole-satoshi payments, so `amountMsat` should be a multiple of `1000`.
- Rounding must happen before LNURL `minSendable` / `maxSendable` validation, because rounding can move a value across a bound.
- Caller-side conversion belongs in the app/graphql layer. The IBEX service wrapper should receive msats and should not import dealer-price or wallet conversion logic.

---

## Follow-Up Implementation Plan: LNURL-Pay From USD/USDT Wallets

> **For implementer:** execute this task-by-task. Do not push without Dread's explicit approval.

**Goal:** Add a wallet-level GraphQL mutation that pays a LNURL-pay endpoint from a USD/USDT cash wallet by converting the user-entered wallet amount into integer millisatoshis before calling `Ibex.payToLnurl`.

**Architecture:** Keep IBEX service code as a thin API wrapper. Decode/fetch/validate the LNURL-pay metadata in the GraphQL/app layer, convert the wallet amount using existing wallet/dealer-price helpers, round to whole satoshis, validate against LNURL bounds, then call `Ibex.payToLnurl({ accountId, amountMsat, params })`.

**Tech Stack:** TypeScript, GraphQL schema builders, existing Flash wallet helpers, `DealerPriceService`, IBEX LNURL-pay API.

### Task 1: Strengthen the IBEX wrapper type

**Files:**
- Modify: `src/services/ibex/index.types.d.ts`
- Modify: `src/services/ibex/client.ts`

**Step 1: Change `PayLnurlArgs.amountMsat` to the existing branded type**

```ts
type PayLnurlArgs = {
  accountId: IbexAccountId,
  amountMsat: MilliSatoshis,
  params: string,
}
```

`MilliSatoshis` already exists globally in `src/domain/bitcoin/index.types.d.ts`. This keeps the service boundary explicit without inventing another unit type.

**Step 2: Keep `client.ts` as a pass-through**

```ts
const payToLnurl = async (
  args: PayLnurlArgs,
): Promise<PayToALnurlPayResponse201 | IbexError> => {
  return Ibex.payToLnurl({
    accountId: args.accountId,
    amount: args.amountMsat,
    params: args.params,
    webhookUrl: WebhookServer.endpoints.onPay.lnurl,
    webhookSecret: WebhookServer.secret,
  }).then(errorHandler)
}
```

Do not add conversion logic here.

### Task 2: Add LNURL-pay conversion helper

**Files:**
- Create: `src/app/payments/lnurl-pay.ts`
- Test: `test/flash/unit/app/payments/lnurl-pay.spec.ts`

**Step 1: Define constants**

```ts
const MSATS_PER_SAT = 1000
const IBEX_LNURL_PAY_AMOUNT_MAX_MSAT = 2_147_483_647
```

**Step 2: Add helper to convert USD/USDT wallet cents to whole-satoshi msats**

Use the same wallet-amount semantics as `ln-noamount-usd-invoice-payment-send.ts`:

```ts
import { toMilliSatsFromNumber } from "@domain/bitcoin"
import { checkedToUsdPaymentAmount } from "@domain/shared"

export const amountMsatFromUsdWalletAmount = async ({
  amount,
  btcFromUsd,
}: {
  amount: UsdWalletAmount
  btcFromUsd: IDealerPriceService["getSatsFromCentsForImmediateSell"]
}): Promise<MilliSatoshis | ApplicationError> => {
  const usdPaymentAmount = checkedToUsdPaymentAmount(
    Number(amount.asUsdCents()),
    WalletCurrency.Usd,
  )
  if (usdPaymentAmount instanceof Error) return usdPaymentAmount

  const sats = await btcFromUsd(usdPaymentAmount)
  if (sats instanceof Error) return sats

  const wholeSats = Math.floor(Number(sats.amount))
  const msats = wholeSats * MSATS_PER_SAT

  return toMilliSatsFromNumber(msats)
}
```

Implementation note: verify the buy/sell dealer method against existing send-lightning semantics before finalizing. The intended behavior is "user spends USD/USDT wallet balance to send BTC over Lightning." Existing outgoing payment flows pass both `hedgeBuyUsd` and `hedgeSellUsd` into the payment-flow builder; tests should pin the chosen dealer method.

**Step 3: Add validation helper**

```ts
export const validateLnurlPayAmountMsat = ({
  amountMsat,
  minSendable,
  maxSendable,
}: {
  amountMsat: MilliSatoshis
  minSendable: number
  maxSendable: number
}): ValidationError | true => {
  if (!Number.isInteger(amountMsat) || amountMsat <= 0) {
    return new InvalidLnurlAmountError("LNURL amount must be positive integer msats")
  }

  if (amountMsat % MSATS_PER_SAT !== 0) {
    return new InvalidLnurlAmountError("LNURL amount must be a whole-satoshi amount")
  }

  if (amountMsat > IBEX_LNURL_PAY_AMOUNT_MAX_MSAT) {
    return new InvalidLnurlAmountError("LNURL amount exceeds IBEX int32 limit")
  }

  if (amountMsat < minSendable || amountMsat > maxSendable) {
    return new InvalidLnurlAmountError("LNURL amount outside minSendable/maxSendable bounds")
  }

  return true
}
```

If no suitable domain error exists, add a small `InvalidLnurlAmountError` near the existing LNURL errors rather than reusing a misleading generic error.

**Step 4: Unit tests**

Cover:

- Converts USD cents to msats using the injected dealer conversion.
- Floors/rounds to whole satoshis, then multiplies by `1000`.
- Rejects `amountMsat % 1000 !== 0`.
- Rejects values below `minSendable` after rounding.
- Rejects values above `maxSendable` after rounding.
- Rejects values above `2_147_483_647` msats.
- Propagates dealer-price errors.

### Task 3: Add wallet-level GraphQL mutation

**Files:**
- Create: `src/graphql/public/root/mutation/lnurl-payment-send.ts`
- Modify: `src/graphql/public/mutations.ts`
- Test: `test/flash/unit/graphql/public/root/mutation/lnurl-payment-send.spec.ts` or the nearest existing GraphQL mutation test path.

**Mutation name:** `lnurlPaymentSend`

**Input shape:**

```ts
const LnurlPaymentSendInput = GT.Input({
  name: "LnurlPaymentSendInput",
  fields: () => ({
    walletId: {
      type: GT.NonNull(WalletId),
      description: "Wallet ID with sufficient balance. Must belong to the current user.",
    },
    lnurl: {
      type: GT.NonNull(Lnurl),
      description: "LNURL-pay value to decode and pay.",
    },
    amount: {
      type: GT.NonNull(FractionalCentAmount),
      description: "Amount to spend from the USD/USDT wallet, in USD cents.",
    },
    memo: {
      type: Memo,
      description: "Optional memo for the Lightning payment.",
    },
  }),
})
```

**Payload:** reuse `PaymentSendPayload`.

**Registration:** import the mutation in `src/graphql/public/mutations.ts` and add it under `mutationFields.authed.atWalletLevel`, next to the other Lightning payment send mutations.

### Task 4: Implement the mutation resolver

**Files:**
- Modify: `src/graphql/public/root/mutation/lnurl-payment-send.ts`

Resolver flow:

1. Validate GraphQL scalar outputs (`walletId`, `lnurl`, `amount`, `memo`) exactly like the existing invoice send mutations.
2. Require `domainAccount`.
3. Resolve the routed wallet ID through `resolveCashWalletMutationWalletIdForAccount({ account: domainAccount, walletId, client: cashWalletClientCapabilities })`.
4. Use `usdWalletAmountFromWalletId({ walletId: routedWalletId, amount: amount.toString() })`.
5. Validate the routed wallet is a USD wallet, allowing USDT by passing `includeUsdt: true` through the existing wallet validation path or by relying on `usdWalletAmountFromWalletId` to reject non-USD/non-USDT currencies.
6. Decode the LNURL through `Ibex.decodeLnurl({ lnurl })`.
7. Fetch the LNURL-pay metadata from the decoded URL if IBEX only returns the callback URL. The metadata must include `callback`, `minSendable`, `maxSendable`, and `metadata`.
8. Serialize the LNURL-pay metadata into the `params` string expected by `Ibex.payToLnurl`. Match IBEX docs for `params`: JSON string containing `callback`, `maxSendable`, `minSendable`, `metadata`, and `tag: "payRequest"`.
9. Convert wallet amount to msats using the helper from Task 2 and `DealerPriceService`.
10. Validate integer, whole-satoshi, int32, and LNURL bounds.
11. Call:

```ts
const payment = await Ibex.payToLnurl({
  accountId: routedWalletId,
  amountMsat,
  params,
})
```

12. Map `IbexError` through `mapAndParseErrorForGqlResponse`.
13. Map IBEX transaction payment status IDs to `PaymentSendStatus` using the same switch as `ln-noamount-usd-invoice-payment-send.ts`.
14. Return `{ errors: [], status: status.value }`.

### Task 5: Add tests for resolver behavior

**Files:**
- Test: `test/flash/unit/graphql/public/root/mutation/lnurl-payment-send.spec.ts`
- Possibly update shared test mocks for `@services/ibex/client` and `@services/dealer-price`.

Test cases:

- Rejects invalid `walletId`, invalid `lnurl`, invalid `amount`, and invalid `memo` scalar outputs.
- Rejects unauthenticated context.
- Routes wallet ID through `resolveCashWalletMutationWalletIdForAccount`.
- Allows USDT cash wallet IDs after cutover routing.
- Calls `Ibex.decodeLnurl` before `Ibex.payToLnurl`.
- Builds `params` with `callback`, `minSendable`, `maxSendable`, `metadata`, and `tag`.
- Converts wallet amount to whole-satoshi msats before calling IBEX.
- Rejects below `minSendable` after rounding.
- Rejects above `maxSendable` after rounding.
- Rejects above the IBEX int32 limit.
- Propagates dealer-price errors.
- Propagates IBEX decode and pay errors as GraphQL payload errors.
- Maps pending/success/failure status IDs to `PaymentSendStatus`.

### Task 6: Update schema artifacts and docs

**Files:**
- Modify if generated: `src/graphql/public/schema.graphql`
- Modify if needed: mobile/backend API docs that list public payment mutations.

Commands:

```bash
yarn write-sdl
```

If `check:sdl` is the project-standard gate for schema drift, run:

```bash
yarn check:sdl
```

### Task 7: Verification

Run focused checks first:

```bash
yarn test:unit --testPathPattern=lnurl-payment-send
```

Run related existing tests:

```bash
yarn test:unit --testPathPattern=ln-noamount-usd-invoice-payment-send
yarn test:unit --testPathPattern=services/ibex/client-usd-wallet
```

Run type checks that cover the changed files:

```bash
npx tsc --noEmit --skipLibCheck
```

If the full repo type check still has unrelated pre-existing failures, capture the exact failure set and verify that none are in:

- `src/services/ibex/client.ts`
- `src/services/ibex/index.types.d.ts`
- `src/app/payments/lnurl-pay.ts`
- `src/graphql/public/root/mutation/lnurl-payment-send.ts`
- new tests

### Task 8: Commit locally only

Stage explicit paths:

```bash
git add \
  src/services/ibex/client.ts \
  src/services/ibex/index.types.d.ts \
  src/app/payments/lnurl-pay.ts \
  src/graphql/public/root/mutation/lnurl-payment-send.ts \
  src/graphql/public/mutations.ts \
  src/graphql/public/schema.graphql \
  test/flash/unit/app/payments/lnurl-pay.spec.ts \
  test/flash/unit/graphql/public/root/mutation/lnurl-payment-send.spec.ts \
  docs/plans/2026-06-05-eng-406-usdt-lnurl-units.md
```

Commit message:

```bash
git commit -m "fix(ibex): wire LNURL-pay msat conversion"
```

Do not push until Dread explicitly asks.
