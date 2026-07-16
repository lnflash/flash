# Account capabilities and nomenclature (ENG-516)

Part of the Account Upgrade Revamp. This is the spec agreed across mobile
(ENG-513), backend, and frappe-flash-admin; business-less Pro (ENG-515)
builds on the state machine defined here.

## Nomenclature

| Internal level | Old user-facing label | New user-facing presentation |
|---|---|---|
| L0 | Trial | **Trial** |
| L1 | Personal | **Verified** |
| L2 | Pro | **Verified** + *Bank payout* badge |
| L3 | Merchant | **Business** |
| — | International | *USD account* badge (capability, not a tier) |

- "Pro" is retired (vague). "International" is retired (it's just a USD
  account). "Merchant" is renamed **Business**.
- Levels (L1/L2/L3) are internal-only — derived from capabilities, never
  shown as a tier the user picks.
- Product decision (2026-07-14): **light headline status**. The account leads
  with one word — Trial → Verified → Business — with capability badges as
  supporting detail (not the pure capability-badge approach).

## Capability model

```
Account = { verified, bankPayout, business, usdAccount }
```

| Capability | Meaning | Source of truth today |
|---|---|---|
| `verified` | phone + ID verified | stored level ≥ 1 (grandfathered) |
| `bankPayout` | approved bank account on file (JM bank) | ERPNext Bank Account records for the account's `erpParty`; stored level ≥ 2 stands in when ERPNext is unavailable |
| `business` | business name + address on file | stored level ≥ 3 (grandfathered) |
| `usdAccount` | USD account + routing number (Bridge) | `bridgeKycStatus === "approved"` |

## State machine (derived level)

```
verified (phone + ID)                        → L1
+ bankPayout, individual                     → L2   (business-less Pro — ENG-515)
+ business (name + address) + bankPayout     → L3
usdAccount                                   → orthogonal flag, any level ≥ L1
```

Implementation: `src/domain/accounts/capabilities.ts`
(`deriveLevelFromCapabilities`, `deriveStatusHeadline`,
`deriveCapabilitiesForAccount`). The stored `account.level` remains the
operational value used by limits and permissions; transitions recompute it
through the state machine.

> **Note — derived level vs stored `level`.** The read model can imply a
> level higher than the stored one: an L1 account with an approved bank
> account on file resolves `bankPayout: true`, which derives to L2. Both the
> stored `level` and the derived `capabilities`/`statusHeadline` are exposed
> over GraphQL, so a client may observe `level: 1` alongside `bankPayout: true`.
> Treat `capabilities` as the source of truth for what the account can do;
> `level` is internal and retained for backward compatibility.

## GraphQL surface

On `ConsumerAccount` (public) and `AuditedAccount` (admin):

```graphql
type AccountCapabilities {
  verified: Boolean!
  bankPayout: Boolean!
  business: Boolean!
  usdAccount: Boolean!
}

enum AccountStatusHeadline {
  TRIAL
  VERIFIED
  BUSINESS
}

# on the account types:
capabilities: AccountCapabilities!
statusHeadline: AccountStatusHeadline!
```

Clients should present `statusHeadline` as the headline and `capabilities`
as badges. `level` stays exposed for compatibility but should not be
displayed as a tier.

## Capability transitions

Clients request a single capability instead of a whole tier:

```graphql
enum AccountCapability {
  BANK_PAYOUT
  BUSINESS
}

input AccountCapabilityUpgradeRequestInput {
  capability: AccountCapability!
  fullName: String!
  address: AddressInput!
  terminalsRequested: Int = 0
  bankAccount: BankAccountInput   # required for BANK_PAYOUT; required for
                                  # BUSINESS unless bankPayout is already held
  idDocument: String
}

mutation {
  accountCapabilityUpgradeRequest(input: …) {
    errors { message }
    id
    status
  }
}
```

The server derives the target level from current capabilities plus the
requested one and posts the existing ERPNext **Account Upgrade Request**
doctype — the human review flow in frappe-flash-admin is unchanged.
`businessAccountUpgradeRequest` (whole-tier, takes a `level`) remains for
existing clients but is superseded by this mutation.

`verified` is granted by the identity flow and `usdAccount` by the Bridge
KYC flow; neither goes through the upgrade-request pipeline.

## Out of scope here

- Mobile presentation (hub + flows): ENG-513.
- Business-less Pro end-to-end flow: ENG-515.
- Persisting capability flags on the account record (today they are a read
  model over existing data; storage can move here later without changing the
  GraphQL contract).
