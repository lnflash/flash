# Authenticated raw owned-wallet metadata

This additive contract is based on deployed/main `5740e7da054f6cebd01ff72edd3e80d7311a99a0`. It introduces `ConsumerAccount.ownedWalletSnapshot`, with no caller account-ID argument. It does not change existing `wallets`, `defaultWalletId`, cash presentation, balances, onboarding, or provider behavior.

```graphql
query OwnedWalletMetadata {
me {
  id
  defaultAccount {
    id
    ... on ConsumerAccount {
      ownedWalletSnapshot {
        publicAccountId
        walletAccountId
        defaultWalletId
        wallets { id accountId walletCurrency isExternal }
      }
    }
  }
}
}
```

`ConsumerAccount.id` is the public account UUID. Existing `Wallet.accountId` is the internal Mongo account ID. They are different namespaces; neither is a conversion of the other. The new snapshot returns both explicitly: `publicAccountId` must match the enclosing account UUID, and every raw wallet `accountId` matches `walletAccountId`. The stored nullable default is returned only if it belongs to an actual returned wallet. Missing defaults are explicitly null, without selecting or creating a wallet. External/BTC defaults are preserved. The list is descriptive: missing or multiple Checking cash currencies do not become eligibility or bootstrap success.

The existing ConsumerAccount wallet list is unsuitable for proving both required cash wallets. `resolveCashWalletPresentation` returns only the visible cash currency: USDT presentation hides legacy USD, while legacy/compat presentation hides USDT. Its default may be a presentation alias rather than the user's stored pointer. A control regression exercises that actual function. This contract bypasses neither authorization nor cash routing; it reads different, explicitly labelled metadata.

The resolver checks the source's internal ID, public UUID, and Kratos owner against the authenticated context before reading repositories. It freshly reads that same account, lists raw owned wallet metadata, and rechecks owner/default after the awaited wallet read. Anonymous, stale/foreign source/context/owner, invalid namespaces, duplicate wallet IDs, nullable/invalid/foreign rows, unsupported currency/type, oversized lists and invalid stored defaults return safe GraphQL errors. There is no arbitrary account argument. Repository errors are replaced with fixed text; credentials, balances and provider prose are absent.

Only projected Mongo `Account.findOne` and bounded `Wallet.find` metadata reads are called. The adapter does not import a provider client or load unrelated account fields. No cutover/presentation/provisioning/balance app service, mutation or provider request runs. It is an ordinary descriptive read, not a transactional snapshot, authorization capability, deployment attestation, balance guarantee or payment permission. Application invariants such as exactly one Checking USD and USDT belong to the consuming bootstrap/readiness boundary.

The nested API-key map requires `read:wallet` at `ConsumerAccount.ownedWalletSnapshot` and `OwnedWalletSnapshot.wallets`; `me` still needs its existing `read:user`. This prevents a read:user key escalating into raw wallet metadata through a nested object. Normal authenticated sessions retain their existing permissions, plus the resolver's explicit owner checks.

The actual GraphQL source type is checked against `src/graphql/public/schema.graphql` and `dev/apollo-federation/supergraph.graphql` in tests. `scripts/generate-owned-wallet-snapshot-sdl.cjs` idempotently derives the two types and field from their runtime GraphQL definitions and extends/sorts the canonical SDL; it never starts the application. Run it under Node24 with `ts-node/register/transpile-only` and `tsconfig-paths/register`, the committed base YAML and a clean dummy-only environment (as in the isolated native-parity runner). Compose the canonical federation artifact using `rover supergraph compose --config dev/apollo-federation/supergraph-config.yaml --elv2-license accept`. No private environment or live service is required for this workflow.

Offline tests cover actual ownership/context checks, raw/public namespace distinction, missing defaults, real external defaults, public-presentation filtering, malformed/nullable/foreign/duplicate records, read-time drift, error redaction, API-key scope mapping, and source/SDL/supergraph agreement. They inject repository reads and make no provider requests. This source patch does not deploy a schema or prove a deployed gateway serves it; native consumers must fail closed if the field is absent.
