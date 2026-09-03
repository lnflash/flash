# ID verification — Phase 0 (backend)

The backend half of Flash's ID-verification tool. Phase 0 adds structured
identity evidence to the account-upgrade request, records a companion
`ID Verification` document in ERPNext for reviewers, lets ERPNext reviewers
complete an approval with the `Flash Admin` role, stops the applicant's PII
from reaching logs, and adds an evidence-retention job. The reviewer UI and
the `ID Verification` doctype itself live in `frappe-flash-admin`; the mobile
capture flow is a separate change.

Everything here is backward compatible: the current mobile app, which sends
only `idDocument`, keeps working with no behaviour change.

## 1. Evidence input contract

Both upgrade mutations — `businessAccountUpgradeRequest` and
`accountCapabilityUpgradeRequest` — accept an optional `evidence` list next
to the existing `idDocument` key:

```graphql
enum UpgradeEvidenceType {
  ID_FRONT
  ID_BACK
  SELFIE
  LIVENESS_FRAME
  BUSINESS_REGISTRATION
  TRN
  PROOF_OF_ADDRESS
  BRIDGE_KYC   # identity established by the account's approved Bridge KYC; no file
}

input UpgradeEvidenceInput {
  type: UpgradeEvidenceType!
  fileKey: String        # key returned by idDocumentUploadUrlGenerate; required unless BRIDGE_KYC
  sha256: String         # hex SHA-256 of the uploaded file, computed client-side
  documentType: String   # passport, drivers_licence, national_id, ...
  issuingCountry: String # ISO 3166-1 alpha-2
}

input BusinessAccountUpgradeRequestInput {
  ...                    # unchanged
  idDocument: String     # legacy, still accepted
  evidence: [UpgradeEvidenceInput!]
}
```

Files are uploaded exactly as today: `idDocumentUploadUrlGenerate` returns a
15-minute presigned PUT and the object key `id_documents/<username>/<file>`
(the `/` separator is deliberate — usernames may contain `_`, so only a
character `UsernameRegex` forbids can unambiguously mark the boundary);
the client then references that key from an evidence row.

### Normalization (`src/domain/accounts/upgrade-evidence.ts`)

`normalizeEvidence({ evidence, idDocument })`:

- a non-empty `idDocument` becomes one `ID_FRONT` row (flagged `legacy`)
  unless an evidence row already carries the same key;
- strings are trimmed, `sha256` lowercased, `issuingCountry` uppercased.

`applyBridgeKycFallback`: an account with an **approved** Bridge KYC that
submits no evidence at all gets a single `BRIDGE_KYC` row, so the request
records where its identity came from.

The legacy `id_document` field on the ERPNext Account Upgrade Request keeps
carrying the first `ID_FRONT` key (`legacyIdDocumentKey`). The existing
reviewer screen and the public `accountUpgradeRequest.idDocument: Boolean`
resolver are unchanged.

### Validation and the strict flag

`validateEvidence({ evidence, level, username, bridgeKycApproved, strict })`,
called from `createUpgradeRequest` before anything is written:

Always:

- unknown evidence type → rejected;
- a `BRIDGE_KYC` row is rejected unless the account's `bridgeKycStatus` is
  `approved`;
- a structured capture row must have a `fileKey`, and that key must start
  with `id_documents/<username>/` (the requesting account's own uploads);
- `sha256`, when present, must be 64 hex characters.

Only when `strict` is true (`UPGRADE_EVIDENCE_STRICT=true`, default false):

- level 2 / level 3 requests need `ID_FRONT` **and** `SELFIE`, **or**
  `BRIDGE_KYC` on an account whose Bridge KYC is approved;
- the legacy `idDocument` row is held to the same file-key rules as
  structured rows. Outside strict mode it is accepted as-is, which is
  today's behaviour.

Flip `UPGRADE_EVIDENCE_STRICT` on once the mobile capture flow is the
minimum supported app version.

## 2. Bridge KYC rule

When the account's Bridge KYC is approved and the evidence contains a
`BRIDGE_KYC` row — including the fallback row above — the backend snapshots
the Bridge customer via `BridgeApiClient.getCustomer` and stores
**only** `id`, `status`, `updated_at` and `endorsements`
(`src/services/bridge/customer-snapshot.ts`). Names, emails and addresses
from the Bridge record are never copied. A snapshot failure is logged at
warn and the request continues without it. The identity source is then
`bridge_kyc`; any other submission is `capture`.

## 3. ERPNext wire

`createUpgradeRequest` still POSTs the Account Upgrade Request first. After
that succeeds it POSTs a companion document (`ErpNext.postIdVerification`,
same token auth + `Host` header as `postUpgradeRequest`):

```
POST /api/resource/ID Verification
{
  "doctype": "ID Verification",
  "upgrade_request": "<Account Upgrade Request name>",
  "status": "Checks pending",
  "identity_source": "bridge_kyc" | "capture",
  "bridge_customer_id": "<Bridge customer id>",          // bridge_kyc only
  "bridge_snapshot_json": "{\"id\":...,\"status\":...}", // bridge_kyc only
  "evidence": [
    {
      "evidence_type": "id_front",   // id_front | id_back | selfie | liveness_frame |
                                     // business_registration | trn | proof_of_address | bridge_kyc
      "document_type": "passport",
      "issuing_country": "JM",
      "file_key": "id_documents/alice/front.jpg",
      "sha256": "…64 hex…",
      "content_type": "image/jpeg",  // derived from the key's extension
      "captured_at": "2026-09-01 12:00:00"  // UTC, Frappe datetime
    }
  ]
}
```

Model: `src/services/frappe/models/IdVerification.ts`.

**Non-fatal by design.** If the POST fails — an older ERPNext without the
doctype, a validation error on the ERPNext side, a network blip — the error
is logged at **warn** (with identifiers only) and the user's upgrade request
succeeds anyway. The Account Upgrade Request already carries the first
`ID_FRONT` key in `id_document`, so reviewers lose nothing they have today.

## 4. Roles: who can complete an approval

Every admin GraphQL field is shielded with `System Manager OR Accounts
Manager` (roles come from the ERPNext-minted JWT). ERPNext reviewers who
hold only `Flash Admin` could open the request but not finish the approval,
because the approval flow calls three admin fields.

`Flash Admin` is now a recognised role (`src/services/frappe/Roles.ts`) and
is added — via an explicit allowlist, never a blanket widening — on exactly
those fields (`src/servers/authorization/admin-permissions.ts`):

| Field | Kind | Why the reviewer needs it |
|---|---|---|
| `accountDetailsByUserPhone` | Query | resolve the applicant's account from the phone on the request |
| `idDocumentReadUrl` | Query | 60-minute presigned GET to view an evidence file |
| `accountUpdateLevel` | Mutation | apply the approved level |

Everything else keeps the default rule. `buildAdminPermissionRules` derives
the graphql-shield map from the allowlist and is unit-tested: Flash Admin
passes on the three fields and is denied on every other query and mutation;
System Manager / Accounts Manager are unchanged.

## 5. PII in logs

- The `console.log` that dumped the latest upgrade request (name, phone,
  email, address) from the public `accountUpgradeRequest` query is removed.
- `ErpNext.postUpgradeRequest`'s error log no longer spreads the request
  body (`...req.toErpnext()`); it logs `username` and `requestedLevel` only.
- The new code paths log identifiers (request names, account id, file keys,
  counts) and never the applicant's name, phone, email or address.

The mobile-side leak is out of scope for this change.

## 6. Retention

### Policy (`src/domain/accounts/evidence-retention.ts`)

Evidence files are kept for `EVIDENCE_RETENTION_YEARS` (default **7**) after
the relationship ends:

| Upgrade request decision | Evidence expires |
|---|---|
| Approved | account closed-at + N years; **never while the account is open** |
| Rejected | decision date + N years |
| Closed (superseded / abandoned) | decision date + N years |
| Pending | never |

`evidenceExpiresAt({ decisionStatus, decidedAt, accountClosedAt,
retentionYears })` is pure and tested. The decision date is the ERPNext
doc's `reviewed_at` when the doctype records one, else its `modified`
timestamp (`ErpNext.getUpgradeRequestDecision`).

**Account closed-at.** Galoy's account schema keeps a `statusHistory` whose
entries carry `updatedAt` (Mongoose default `Date.now`, required), so the
closure timestamp *is* derivable without a schema change:
`getAccountClosedAt(account)` returns the `updatedAt` of the latest
`closed` entry, but only while the account's current status is still
`closed` — a reopened account restarts the clock. `locked` is not closure
(an admin lock is reversible and the relationship continues). No new field
was added to the account schema.

### Job (`src/app/accounts/run-evidence-retention.ts`)

Runs as a task in the existing cron server (`src/servers/cron.ts`,
`evidenceRetentionJob`), every invocation:

1. page through ERPNext `ID Verification` names
   (`ErpNext.getIdVerificationList`);
2. for each with an evidence row that has a `file_key` and no `deleted_at`,
   read the linked Account Upgrade Request decision; skip `Pending`;
3. for `Approved`, look the account up by username in Mongo and compute
   closed-at;
4. if `evidenceExpiresAt` is in the past: delete each file from Spaces
   (`deleteIdDocument`, which refuses any key outside `id_documents/`) and
   stamp `deleted_at` on the row. Frappe has no PATCH for a child row; the
   job PUTs the parent's full `evidence` table with the stamped rows
   (`ErpNext.updateIdVerificationEvidence`) — rows missing from that PUT
   would be dropped, so the whole table is always sent.

Per-record failures are counted and logged, never fatal; only a listing
failure fails the task. The task returns a summary (`scanned`, `expired`,
`filesDeleted`, `filesWouldDelete`, `skipped`, `errors`).

**Dry run.** `EVIDENCE_RETENTION_DRY_RUN` defaults to **true** for the first
release: the job logs `evidence retention: would delete` with the file key
and expiry for every expired row and touches neither Spaces nor ERPNext.
Set it to `false` to delete for real. A file delete that succeeds but whose
ERPNext stamp fails is retried next run (S3-style deletes are idempotent).

Storage additions (`src/services/storage/index.ts`): `deleteIdDocument({
fileKey })` and `listIdDocuments({ prefix, continuationToken })`, both
restricted to the `id_documents/` prefix.

## Environment flags

| Variable | Default | Effect |
|---|---|---|
| `UPGRADE_EVIDENCE_STRICT` | `false` | enforce the identity-evidence requirement and legacy-key rules |
| `EVIDENCE_RETENTION_YEARS` | `7` | retention window |
| `EVIDENCE_RETENTION_DRY_RUN` | `true` | log instead of deleting |

Booleans accept `true/false`, `1/0`, `yes/no`, `on/off`.

## Not in this change

- The `ID Verification` doctype, its child table and the reviewer UI
  (frappe-flash-admin). Field names above are the contract.
- Mobile capture flow and the mobile-side PII log.
- Any admin GraphQL surface for the ID Verification record itself; Phase 0
  reviewers work from ERPNext.
