# USDT Cent Scale Boundary Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Flash app-facing USDT amounts use USD-cent scale, so `$1.00` USDT is represented as `100`, while converting to IBEX USDT micro-units only at provider boundaries.

**Architecture:** Keep `USDTAmount` internally precise in IBEX-compatible micro-USDT units because provider balances and invoices need six decimals. Add explicitly named USD-cent conversion helpers on `USDTAmount`, use those helpers at GraphQL/app boundaries, and leave `USDTAmount.toIbex()` plus IBEX/Bridge service code as the provider-facing conversion point. The implementation must make each boundary choose a named unit; no app/mobile/API code should pass raw USDT micros by accident.

**Tech Stack:** TypeScript, Jest, GraphQL type resolvers, Flash `MoneyAmount` domain classes, IBEX adapter.

---

## Branch And Safety Constraints

- Work directly in `/Users/dread/Documents/Island-Bitcoin/Flash/flash`.
- The checkout is already on `tmp/bridge-rebase-pr-ready`; do not create a child branch.
- Preserve existing dirty/untracked files unless they are part of this task.
- Before editing, run:

```bash
git status --short --branch
git diff -- src/domain/shared/MoneyAmount.ts src/app/wallets/usd-wallet-amount.ts src/graphql/shared/types/scalar/usd-cents.ts src/graphql/shared/types/object/usdt-wallet.ts test/flash/unit/app/wallets/usd-wallet-amount.spec.ts test/flash/unit/app/payments/send-intraledger.spec.ts test/flash/unit/graphql/shared/types/scalar/usd-cents.spec.ts
```

Expected: branch is `tmp/bridge-rebase-pr-ready`. Existing unrelated changes may be present, but the listed USDT unit files should be understood before editing.

## Core Invariant

- App/API/mobile cent scale:
  - `$1.00 USD` -> `100`
  - `$1.00 USDT` -> `100`
- USDT provider scale inside `USDTAmount`:
  - `$1.00 USDT` -> `1_000_000` micro-USDT
  - `1` USD cent -> `10_000` micro-USDT
- IBEX boundary:
  - `USDTAmount.toIbex()` still returns major USDT, e.g. `194.46`.
  - IBEX parser code still uses `USDTAmount.fromNumber(...)` for major USDT balances.

## Unit Boundary Table

| Layer | Canonical unit | Allowed helpers |
| --- | --- | --- |
| Mobile/API stable-wallet inputs | USD-equivalent cents | `USDAmount.cents`, `USDTAmount.usdCents` |
| GraphQL wallet balance output | cents; fractional cents only when the field type is `FractionalCentAmount` | `USDAmount.asCents`, `USDTAmount.asUsdCents` |
| Domain/provider storage for USDT | micro-USDT | `USDTAmount.smallestUnits` |
| IBEX request payloads | major USDT number | `USDTAmount.toIbex` |
| IBEX response parsing | major USDT number -> micro-USDT domain amount | `USDTAmount.fromNumber` |

Rules:
- `USDTAmount.smallestUnits(...)` is provider/internal only.
- `USDTAmount.usdCents(...)` is app/API/mobile input only.
- `USDTAmount.asUsdCents(...)` is app/API/mobile output only.
- Generic helpers such as `MoneyAmount.from(...)`, `asPaymentAmount()`, GraphQL scalar parsing, bridge quote/withdrawal resolvers, and mobile mutation adapters must be audited before implementation is considered complete.

## Quantization Policy

Provider-originated USDT balances can contain sub-cent values because IBEX supports six decimals and one USD cent equals `10_000` micro-USDT.

- Do not quantize before provider validation, balance checks, reconciliation, invoice/payment creation, or persistence. These flows stay in exact micro-USDT.
- For `FractionalCentAmount` balance outputs, expose exact fractional cents to four decimals because `1` micro-USDT equals `0.0001` cent. Example: `9_147_993` micros -> `914.7993` cents.
- For integer-cent inputs from mobile/API, reject fractional cent input unless an existing scalar explicitly supports fractional cents for that mutation.
- For any output field that is contractually integer cents, do not silently round sub-cent USDT. Either return an error for non-cent-clean values or add a separate fractional-cent field/type.

## Rollout Contract

This plan targets the development branch `tmp/bridge-rebase-pr-ready`. No production Flash Mobile client currently ships IBEX USDT code that depends on the old micro-USDT app/API semantics, so this is not a production backwards-compatibility migration.

Rules:
- Treat the USD-cent USDT contract as the canonical contract for this development branch.
- Do not add legacy micro-USDT compatibility code, version flags, or dual-parse heuristics just for old clients unless a concrete caller is found during the audit.
- If the audit finds an existing non-production caller inside this branch that still sends micro-USDT through an app/API path, update that caller to the cent-scale contract.
- If a production mixed-client window is later introduced, stop and write a separate rollout plan before shipping.

## Numeric Safety Policy

Existing GraphQL balance fields return JavaScript `number`, so this plan keeps that shape unless the schema is intentionally changed. That has a safe-integer limit.

- Before adding new `Number(...)` conversions, check whether the field already returns `number`.
- Add at least one max-range test around the largest realistic USDT wallet balance expected by product.
- If a converted cent value can exceed `Number.MAX_SAFE_INTEGER`, stop and change the wire type to a string/BigInt-compatible scalar instead of silently returning an unsafe number.

## Task 1: Add Red Tests For USDT Cent-Scale Input

**Files:**
- Modify: `test/flash/unit/app/wallets/usd-wallet-amount.spec.ts`
- Modify: `test/flash/unit/app/payments/send-intraledger.spec.ts`

**Step 1: Update wallet amount expectations**

Change the USDT case in `usd-wallet-amount.spec.ts` so an input of `19446` represents `$194.46` USDT.

Expected assertions:

```ts
expect(result).toBeInstanceOf(USDTAmount)
expect(result.asSmallestUnits()).toBe("194460000")
expect(result.toIbex()).toBe(194.46)
```

**Step 2: Update intraledger expectations**

In `send-intraledger.spec.ts`, rename the test from micro-unit semantics to cent-scale semantics and update:

```ts
expect(mockAddInvoice.mock.calls[0][0].amount.asSmallestUnits()).toBe("194460000")
expect(mockAddInvoice.mock.calls[0][0].amount.toIbex()).toBe(194.46)
```

**Step 3: Run the focused tests and confirm failure**

```bash
TEST='test/flash/unit/app/wallets/usd-wallet-amount.spec.ts test/flash/unit/app/payments/send-intraledger.spec.ts' yarn test:unit --runInBand
```

Expected: failures still show USDT input `19446` being treated as micro-USDT.

## Task 2: Add Explicit USDT USD-Cent Helpers

**Files:**
- Modify: `src/domain/shared/MoneyAmount.ts`

**Step 1: Add constants near `USDTAmount`**

```ts
const USDT_MICROS_PER_MAJOR_UNIT = 1_000_000n
const USDT_MICROS_PER_USD_CENT = 10_000n
```

Use these constants in `USDTAmount.fromNumber`, `asNumber`, and new helpers to remove magic numbers.

**Step 2: Add constructor for app/API cent input**

Add:

```ts
static usdCents(cents: string | bigint): USDTAmount | BigIntConversionError {
  try {
    const centAmt = new Money(cents.toString(), "USDTUsdCents", Round.HALF_TO_EVEN)
    return new USDTAmount(
      centAmt.multiply(USDT_MICROS_PER_USD_CENT.toString()).toFixed(0),
    )
  } catch (error) {
    return new BigIntConversionError(
      error instanceof Error ? error.message : String(error),
    )
  }
}
```

If `Money.multiply(...)` does not accept the value cleanly in this form, use the same local style as `USDAmount.dollars(...)`: create a `USDTAmount.smallestUnits(USDT_MICROS_PER_USD_CENT)` multiplier and multiply money values.

**Step 3: Add serializer for app/API cent output**

Add:

```ts
asUsdCents(precision: number = 0): string {
  return this.money.divide(USDT_MICROS_PER_USD_CENT.toString()).toFixed(precision)
}
```

The default precision mirrors the integer-cent expectation. Call `asUsdCents(4)` only for fields whose schema explicitly allows fractional cents, such as `FractionalCentAmount` wallet balances.

**Step 4: Run the domain compile target indirectly**

```bash
TEST='test/flash/unit/app/wallets/usd-wallet-amount.spec.ts' yarn test:unit --runInBand
```

Expected: it may still fail until Task 3 wires the helper into the app input path, but TypeScript/Jest should compile.

## Task 3: Wire App-Facing USDT Input To Cent Scale

**Files:**
- Modify: `src/app/wallets/usd-wallet-amount.ts`

**Step 1: Change USDT input conversion**

Replace:

```ts
if (currency === WalletCurrency.Usdt) return USDTAmount.smallestUnits(raw)
```

With:

```ts
if (currency === WalletCurrency.Usdt) return USDTAmount.usdCents(raw)
```

**Step 2: Run focused tests**

```bash
TEST='test/flash/unit/app/wallets/usd-wallet-amount.spec.ts test/flash/unit/app/payments/send-intraledger.spec.ts' yarn test:unit --runInBand
```

Expected: the updated cent-scale tests pass. Mixed-currency tests remain unchanged.

## Task 4: Add Red Tests For GraphQL USDT Serialization

**Files:**
- Modify: `test/flash/unit/graphql/shared/types/scalar/usd-cents.spec.ts`
- Test gap to inspect: there may not be an existing `UsdtWallet.balance` unit spec. If absent, do not create a broad GraphQL integration suite just for this; cover the scalar and keep the resolver change simple.

**Step 1: Update `USDCents` scalar test**

Add or update a test proving USDT serializes as USD cents, not micro-USDT:

```ts
const amount = USDTAmount.smallestUnits("9147993")
if (amount instanceof Error) throw amount

expect(USDCentsScalar.serialize(amount)).toBe(914.7993)
```

This represents `9.147993 USDT`, which should be `914.7993` cents.

**Step 2: Run scalar test and confirm failure**

```bash
TEST='test/flash/unit/graphql/shared/types/scalar/usd-cents.spec.ts' yarn test:unit --runInBand
```

Expected: failure currently returns `9147993`.

## Task 5: Wire GraphQL USDT Output To Cent Scale

**Files:**
- Modify: `src/graphql/shared/types/scalar/usd-cents.ts`
- Modify: `src/graphql/shared/types/object/usdt-wallet.ts`

**Step 1: Update scalar serialization**

Replace:

```ts
return Number(value.asSmallestUnits())
```

With:

```ts
return Number(value.asUsdCents(4))
```

**Step 2: Update USDT wallet balance resolver**

Replace:

```ts
return Number(balance.asSmallestUnits(8))
```

With:

```ts
return Number(balance.asUsdCents(4))
```

**Step 3: Run scalar test**

```bash
TEST='test/flash/unit/graphql/shared/types/scalar/usd-cents.spec.ts' yarn test:unit --runInBand
```

Expected: scalar test passes.

## Task 6: Audit For Remaining App-Facing Micro-USDT Leaks

**Files:**
- Inspect only unless tests reveal a real gap.

**Step 1: Search for USDT smallest-unit usage**

```bash
rg "asSmallestUnits\\(|USDTAmount\\.smallestUnits|asNumber\\(|toIbex\\(" src test/flash/unit
```

**Step 2: Search all GraphQL USDT response surfaces**

```bash
rg "USDTAmount|WalletCurrency.*Usdt|UsdtWallet|walletCurrency|balance|amount" src/graphql test/flash/unit/graphql
```

For each resolver/serializer that can return a USDT amount, document whether it is:
- mobile/API-facing stable-wallet cents,
- provider/internal micros,
- provider major units,
- unrelated non-USDT data.

Add focused tests for every mobile-visible USDT amount field that changes unit semantics. Do not rely on scalar tests alone if a resolver bypasses the scalar.

**Step 3: Search constructor/parser/payment helper seams**

```bash
rg "MoneyAmount\\.from|asPaymentAmount\\(|parseValue\\(|parseLiteral\\(|normalizePaymentAmount|PaymentAmount|USDCents" src test/flash/unit
```

**Step 4: Classify each hit**

Provider/internal uses that should stay micro/major:
- `src/services/ibex/client.ts`
- `src/services/bridge/index.ts`
- cash-wallet cutover fee/audit internals
- persistence or provider parsing code

App/API-facing uses that should be cent-scale:
- GraphQL wallet balances
- `USDCents` scalar serialization
- wallet amount input helpers used by mobile mutations
- `MoneyAmount.from(..., WalletCurrency.Usdt)` if the caller is app/API/mobile-facing
- `asPaymentAmount()` only if the caller is provider-facing or explicitly expects provider major units
- GraphQL mutation parsing paths that use `USDCents.parseValue` before wallet currency is known

**Step 5: Patch confirmed app/API leaks**

Do not broadly replace every `USDTAmount.smallestUnits`. That method is still correct for IBEX provider data, fee audit data, and stored micro-USDT values.

Specific expected decisions:
- If `MoneyAmount.from(..., WalletCurrency.Usdt)` is used by app/API/mobile code, change USDT there to `USDTAmount.usdCents(...)`. If it is used for persistence/provider rehydration, split it into two named constructors instead of changing it globally.
- Do not change `USDCents.parseValue` to return `USDTAmount`, because the scalar does not know wallet currency. Move currency-specific amount construction into resolvers/helpers that already know the wallet currency, or add a separate USDT-aware input path.
- Audit bridge quote/withdrawal paths and add tests proving mobile cent-scale inputs convert exactly once before provider calls, or proving those paths are provider-only and should keep current units.
- Audit all `asPaymentAmount()` usage. If USDT reaches app/API/mobile through it, override or fence it; otherwise document it as provider-facing only.

## Task 7: Add Boundary Tests From Review

**Files:**
- Modify or add focused tests only where the corresponding code path exists.

**Step 1: Domain helper tests**

Add tests for:
- `USDTAmount.usdCents("0")` -> `0` micros -> `0` IBEX.
- `USDTAmount.usdCents("1")` -> `10000` micros -> `0.01` IBEX.
- `USDTAmount.usdCents("100")` -> `1000000` micros -> `1` IBEX.
- negative input behavior, matching existing `Money`/amount class conventions.
- `USDTAmount.smallestUnits("19446").asUsdCents(4)` -> `"1.9446"`.
- `USDTAmount.smallestUnits("19999").asUsdCents(4)` -> `"1.9999"`.
- A large amount that remains within GraphQL number safety if the API still returns `number`; if the realistic upper bound is unsafe, change the plan to use a string scalar before implementing.

**Step 2: Generic constructor/parser tests**

If `MoneyAmount.from(..., WalletCurrency.Usdt)` is changed or split, add a test that locks the selected semantics.

If GraphQL mutation input parsing is changed, add a test proving USDT input parsing is cent-scale and USD input parsing is unchanged.

**Step 3: GraphQL output tests**

Add resolver/serialization tests for every mobile-visible GraphQL USDT amount field discovered in Task 6. At minimum:
- `USDCents` serialization for a cent-clean USDT value.
- `USDCents` or `FractionalCentAmount` serialization for a non-cent-clean USDT value, according to the quantization policy.
- `UsdtWallet.balance` returns cent-scale/fractional-cent-scale, not raw micro-USDT.

**Step 4: Development-branch contract test**

Add a test proving the development-branch contract is unambiguous:
- USDT app/API input `100` means `$1.00` / `1_000_000` micro-USDT.
- There is no silent compatibility path that interprets the same input as `100` micro-USDT.
- If an existing branch-local caller still sends micro-USDT through an app/API path, update that caller and cover it with a focused test.

**Step 5: Provider boundary tests**

Add or update one focused provider-boundary test proving a mobile/API input of `19446` cents becomes:

```ts
amount.asSmallestUnits() === "194460000"
amount.toIbex() === 194.46
```

And that provider-originated `USDTAmount.fromNumber("194.46")` still yields the same internal micros.

## Task 8: Full Verification

**Files:**
- All modified files.

**Step 1: Run focused tests**

```bash
TEST='test/flash/unit/app/wallets/usd-wallet-amount.spec.ts test/flash/unit/app/payments/send-intraledger.spec.ts test/flash/unit/graphql/shared/types/scalar/usd-cents.spec.ts' yarn test:unit --runInBand
```

Expected: all pass.

**Step 2: Run build**

```bash
yarn build
```

Expected: build completes successfully.

**Step 3: Review diff**

```bash
git diff -- src/domain/shared/MoneyAmount.ts src/app/wallets/usd-wallet-amount.ts src/graphql/shared/types/scalar/usd-cents.ts src/graphql/shared/types/object/usdt-wallet.ts test/flash/unit/app/wallets/usd-wallet-amount.spec.ts test/flash/unit/app/payments/send-intraledger.spec.ts test/flash/unit/graphql/shared/types/scalar/usd-cents.spec.ts
```

Expected: no unrelated files, no IBEX adapter conversion behavior changed except through existing `USDTAmount.toIbex()`.

## Task 9: Commit Directly On `tmp/bridge-rebase-pr-ready`

**Files:**
- Stage only the plan and the intentional USDT unit files.

**Step 1: Stage explicit paths**

```bash
git add docs/plans/2026-05-29-usdt-cent-scale-boundary.md \
  src/domain/shared/MoneyAmount.ts \
  src/app/wallets/usd-wallet-amount.ts \
  src/graphql/shared/types/scalar/usd-cents.ts \
  src/graphql/shared/types/object/usdt-wallet.ts \
  test/flash/unit/app/wallets/usd-wallet-amount.spec.ts \
  test/flash/unit/app/payments/send-intraledger.spec.ts \
  test/flash/unit/graphql/shared/types/scalar/usd-cents.spec.ts
```

**Step 2: Commit**

```bash
git commit -m "fix: expose usdt wallet amounts in usd cents"
```

## Review Questions For Dual-Model Review

1. Does adding `USDTAmount.usdCents(...)` and `USDTAmount.asUsdCents(...)` preserve a clear app/API boundary without corrupting provider-facing IBEX precision?
2. Should `USDTAmount.asPaymentAmount()` remain inherited from `MoneyAmount`, or does it create an app-facing micro-unit leak that needs a targeted override?
3. Are GraphQL `USDCents`, `UsdtWallet.balance`, transaction history, and payment/invoice mutation paths fully inventoried for mobile-visible unit semantics?
4. Is the quantization policy correct: exact micros internally, fractional cents only on `FractionalCentAmount`, no silent rounding on integer-cent contracts?
5. Are there bridge withdrawal or quote paths that accept mobile cent-scale USDT input but bypass `usdWalletAmountFromInput`?
