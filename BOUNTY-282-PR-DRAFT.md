## Bounty #282 — JMD Currency Precision — Backend Fix

### Payment
BTC payout address: `1Ast5dKr9z1bLWFBnyh6WDQSgyL7EHJosp`

### Target
- Repository: `lnflash/flash`
- Issue: `https://github.com/lnflash/flash/issues/282`
- Scope covered in this patch: backend transaction adaptor and backend price service portions of the JMD precision bug.

### Issues Addressed

#### 1. Transaction adaptor preserves fractional settlement amounts
- **Reproduction path:** `toWalletTransactions()` receives Ibex transaction amounts such as `625.78` USD cents after JMD → USD conversion.
- **Impact:** GraphQL/payment layers expect integer minor units. Preserving floats risks downstream truncation and users receiving/sending slightly less than intended.
- **Root cause:** `asCurrency()` cast raw `number | undefined` directly to `UsdCents | Satoshis` without integer rounding.
- **Fix:** `asCurrency()` now rounds defined numeric amounts before casting to wallet minor units.
- **File:** `src/app/wallets/get-transactions-for-wallet.ts`

#### 2. Transaction adaptor floors exchange-rate display price
- **Reproduction path:** `toWalletTransactions()` receives fractional `exchangeRateCurrencySats` from Ibex.
- **Impact:** `Math.floor()` always biases the historical display price downward, compounding precision loss in JMD transaction history.
- **Root cause:** `settlementDisplayPrice.base` used `Math.floor()`.
- **Fix:** Use `Math.round()` for unbiased integer minor-unit conversion.
- **File:** `src/app/wallets/get-transactions-for-wallet.ts`

#### 3. USD→JMD realtime price triangulates through BTC
- **Reproduction path:** `PriceService().getUsdCentRealTimePrice({ displayCurrency: "JMD" })` uses BTC price feeds instead of the configured static exchange rate.
- **Impact:** JMD cashout/display calculations inherit BTC-feed precision and volatility even though the app has a configured JMD sell rate.
- **Root cause:** `getRealTimePrice()` handled all USD-wallet display currencies through BTC triangulation.
- **Fix:** Special-case JMD display currency for USD wallet prices and return `ExchangeRates.jmd.sell.asCents() / CENTS_PER_USD`, i.e. JMD cents per USD cent from config.
- **File:** `src/services/price/index.ts`

### Tests Added
- `test/flash/unit/app/wallets/get-transactions-for-wallet.spec.ts`

Coverage:
- USD fractional amount rounds to cents.
- BTC fractional amount rounds to sats.
- Send transaction sign is preserved.
- Fractional `exchangeRateCurrencySats` rounds into `settlementDisplayPrice.base`.

### Validation Attempted
- Command attempted:
  ```bash
  TEST='get-transactions-for-wallet.spec.ts' yarn test:unit --runInBand --testPathPattern='get-transactions-for-wallet.spec.ts'
  ```
- Result in this environment:
  - blocked by local Node version mismatch: repo requires `>=20.18.1 <21`, environment has Node `22.22.2`.
  - `node_modules` is not installed, so direct local Jest is unavailable.

### Notes
- This patch does not claim the mobile-side fixes from the issue. The issue mentions `lnflash/flash-mobile`; that requires a separate repository patch.
- This patch is ready for review/submission once a valid GitHub login/session is available.
