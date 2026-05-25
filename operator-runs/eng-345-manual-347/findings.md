# Findings

- `preparePrimaryCashWalletCutover` accepts injected repositories, so the test can scope discovery to the 10 created accounts by passing an `accountsRepo.listUnlockedAccounts()` generator for only those IDs.
- Account creation creates both USD and USDT checking wallets and defaults new accounts to USDT. For this test, each new account must be explicitly updated back to the USD wallet with `Accounts.updateDefaultWalletId`.
- Funding can use `Payments.intraledgerPaymentSendWalletIdForUsdWallet` from the funder account's USD wallet to each target legacy USD wallet. The amount argument is cents, so `$0.25` is `25` and `$0.01` is `1`.
- Cutover batch execution can use `CashWalletCutover.runPrimaryCashWalletCutoverBatch`; status and lifecycle can use the existing app lifecycle functions.
