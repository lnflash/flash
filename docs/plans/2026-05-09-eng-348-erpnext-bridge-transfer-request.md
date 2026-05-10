# ENG-348 ERPNext Bridge Transfer Request Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build ERPNext + Flash backend support for writing one `Bridge Transfer Request` record per Bridge-backed Cash Wallet topup/cashout request.

**Architecture:** Add a normal Frappe DocType named `Bridge Transfer Request`, then add a Flash backend ERPNext upsert writer that maps Bridge and IBEX webhook events into that DocType. Webhook handlers call the writer after existing local persistence/status updates; ERPNext write failures return 500 and log structured fields for ENG-362.

**Tech Stack:** Frappe/ERPNext DocType JSON + Python controller, TypeScript Flash backend, Axios ERPNext REST API, Jest unit tests, existing Bridge/IBEX webhook routes from PR #344.

---

## Preconditions

- Base branch/worktree should include PR #344 (`eng-296/ibex-usdt-provisioning`) or a branch where PR #344 has merged into `feature/bridge-integration`.
- Design doc: `docs/plans/2026-05-09-eng-348-erpnext-bridge-transfer-request-design.md`.
- Repos involved:
  - Flash backend: `/Users/dread/Documents/Island-Bitcoin/Flash/flash`
  - Frappe app: `/Users/dread/Documents/Island-Bitcoin/Flash/frappe-flash-admin`

## Task 1: Add Frappe DocType skeleton

**Files:**
- Create: `/Users/dread/Documents/Island-Bitcoin/Flash/frappe-flash-admin/admin_panel/admin_panel/doctype/bridge_transfer_request/__init__.py`
- Create: `/Users/dread/Documents/Island-Bitcoin/Flash/frappe-flash-admin/admin_panel/admin_panel/doctype/bridge_transfer_request/bridge_transfer_request.py`
- Create: `/Users/dread/Documents/Island-Bitcoin/Flash/frappe-flash-admin/admin_panel/admin_panel/doctype/bridge_transfer_request/bridge_transfer_request.json`

**Step 1: Create DocType files**

Create the directory and files. Controller can start minimal:

```python
import frappe
from frappe.model.document import Document


class BridgeTransferRequest(Document):
    pass
```

**Step 2: Add DocType JSON**

Use a normal, non-submittable DocType with module `Admin Panel`, default list view, and System Manager permissions. Include at minimum:

- `request_id` Data, required, unique, in list view
- `transaction_type` Select: `Topup\nCashout`, required, in list view
- `status` Select: `Pending\nFiat Received\nSettled\nCompleted\nFailed`, required, in list view
- `provider` Select: `Bridge`, required
- `asset` Data or Select, default `USDT`
- `network` Data or Select, default `Ethereum`
- `amount` Data
- `currency` Data
- `developer_fee` Data
- `initial_amount` Data
- `subtotal_amount` Data
- `final_amount` Data
- `account_id` Data
- `wallet_id` Data
- `bridge_customer_id` Data
- `bridge_transfer_id` Data
- `ibex_tx_hash` Data
- `address` Data
- `source_systems_seen` Small Text
- `raw_payload_json` Code
- `first_seen_at` Datetime
- `last_seen_at` Datetime

**Step 3: Verify JSON loads**

Run:

```bash
cd /Users/dread/Documents/Island-Bitcoin/Flash/frappe-flash-admin
python3 -m json.tool admin_panel/admin_panel/doctype/bridge_transfer_request/bridge_transfer_request.json >/dev/null
```

Expected: exits 0.

**Step 4: Commit**

```bash
git add admin_panel/admin_panel/doctype/bridge_transfer_request
git commit -m "feat: add Bridge Transfer Request doctype"
```

## Task 2: Add Frappe DocType validation tests or fixture check

**Files:**
- Create: `/Users/dread/Documents/Island-Bitcoin/Flash/frappe-flash-admin/admin_panel/tests/test_bridge_transfer_request_doctype.py`

**Step 1: Write fixture/JSON test**

Add a lightweight Python test that loads the DocType JSON and asserts required fields exist and `request_id` is unique.

```python
import json
from pathlib import Path


def test_bridge_transfer_request_doctype_has_required_fields():
    path = Path(__file__).parents[1] / "admin_panel" / "doctype" / "bridge_transfer_request" / "bridge_transfer_request.json"
    doc = json.loads(path.read_text())
    fields = {field["fieldname"]: field for field in doc["fields"] if "fieldname" in field}

    for fieldname in [
        "request_id",
        "transaction_type",
        "status",
        "provider",
        "asset",
        "network",
        "bridge_transfer_id",
        "ibex_tx_hash",
        "raw_payload_json",
    ]:
        assert fieldname in fields

    assert fields["request_id"].get("unique") == 1
    assert fields["request_id"].get("reqd") == 1
    assert doc.get("is_submittable", 0) == 0
```

**Step 2: Run test**

Run whatever local test command is already used in this repo. If none is configured, run:

```bash
cd /Users/dread/Documents/Island-Bitcoin/Flash/frappe-flash-admin
python3 -m pytest admin_panel/tests/test_bridge_transfer_request_doctype.py
```

Expected: PASS, or document missing pytest as a local environment blocker.

**Step 3: Commit**

```bash
git add admin_panel/tests/test_bridge_transfer_request_doctype.py
git commit -m "test: cover Bridge Transfer Request doctype schema"
```

## Task 3: Add Flash backend model for ERPNext payload

**Files:**
- Create: `/Users/dread/Documents/Island-Bitcoin/Flash/flash/src/services/frappe/models/BridgeTransferRequest.ts`
- Test: `/Users/dread/Documents/Island-Bitcoin/Flash/flash/test/flash/unit/services/frappe/models/BridgeTransferRequest.spec.ts`

**Step 1: Write failing tests**

Test that a minimal topup and cashout request convert to ERPNext field names.

```ts
import { BridgeTransferRequest } from "@services/frappe/models/BridgeTransferRequest"

describe("BridgeTransferRequest", () => {
  it("serializes a topup request for ERPNext", () => {
    const req = BridgeTransferRequest.fromInput({
      requestId: "bridge-transfer-001",
      transactionType: "Topup",
      status: "Fiat Received",
      provider: "Bridge",
      asset: "USDT",
      network: "Ethereum",
      amount: "100.00",
      currency: "USD",
      bridgeTransferId: "bridge-transfer-001",
      bridgeCustomerId: "cust-001",
      sourceSystem: "Bridge",
      providerEventId: "event-001",
      rawPayload: { hello: "world" },
    })

    expect(req.toErpnext()).toEqual(expect.objectContaining({
      doctype: "Bridge Transfer Request",
      request_id: "bridge-transfer-001",
      transaction_type: "Topup",
      status: "Fiat Received",
      provider: "Bridge",
      asset: "USDT",
      network: "Ethereum",
      bridge_transfer_id: "bridge-transfer-001",
      bridge_customer_id: "cust-001",
      raw_payload_json: JSON.stringify({ hello: "world" }),
    }))
  })
})
```

**Step 2: Run test to verify failure**

```bash
cd /Users/dread/Documents/Island-Bitcoin/Flash/flash
TEST=test/flash/unit/services/frappe/models/BridgeTransferRequest.spec.ts yarn test:unit
```

Expected: FAIL because model does not exist.

**Step 3: Implement model**

Create a class with:

- static `doctype = "Bridge Transfer Request"`
- `fromInput(input)`
- `toErpnext()` mapping camelCase to snake_case
- default `provider = "Bridge"`, `asset = "USDT"`, `network = "Ethereum"`
- JSON stringify for `rawPayload`
- timestamps defaulting to `new Date().toISOString()` if absent

**Step 4: Run test**

```bash
TEST=test/flash/unit/services/frappe/models/BridgeTransferRequest.spec.ts yarn test:unit
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/services/frappe/models/BridgeTransferRequest.ts test/flash/unit/services/frappe/models/BridgeTransferRequest.spec.ts
git commit -m "feat: model ERPNext bridge transfer requests"
```

## Task 4: Add ERPNext upsert method

**Files:**
- Modify: `/Users/dread/Documents/Island-Bitcoin/Flash/flash/src/services/frappe/ErpNext.ts`
- Modify: `/Users/dread/Documents/Island-Bitcoin/Flash/flash/src/services/frappe/errors.ts`
- Test: `/Users/dread/Documents/Island-Bitcoin/Flash/flash/test/flash/unit/services/frappe/ErpNext.spec.ts` or create focused spec if existing pattern differs.

**Step 1: Add failing tests**

Mock Axios and test:

1. GET by `request_id` returns empty → POST creates record.
2. GET returns existing name → PUT updates record.
3. POST uniqueness conflict → re-query and update/return success.
4. Axios error returns `BridgeTransferRequestUpsertError`.

**Step 2: Run test to verify failure**

```bash
TEST=test/flash/unit/services/frappe/ErpNext.spec.ts yarn test:unit
```

Expected: FAIL because method/error does not exist.

**Step 3: Implement error type**

Add to `errors.ts`:

```ts
export class BridgeTransferRequestUpsertError extends Error {
  name = "BridgeTransferRequestUpsertError"
}
```

Follow existing project error style if different.

**Step 4: Implement method**

Add `upsertBridgeTransferRequest(req: BridgeTransferRequest)`:

- GET `/api/resource/Bridge Transfer Request` with filters for request_id.
- If no existing row: POST `req.toErpnext()`.
- If existing row: PUT `/api/resource/Bridge Transfer Request/${name}` with `req.toErpnext()`.
- Log structured errors with response data.

**Step 5: Run tests**

```bash
TEST=test/flash/unit/services/frappe/ErpNext.spec.ts yarn test:unit
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/services/frappe/ErpNext.ts src/services/frappe/errors.ts test/flash/unit/services/frappe/ErpNext.spec.ts
git commit -m "feat: upsert Bridge Transfer Request in ERPNext"
```

## Task 5: Add mapping/writer service

**Files:**
- Create: `/Users/dread/Documents/Island-Bitcoin/Flash/flash/src/services/frappe/BridgeTransferRequestWriter.ts`
- Test: `/Users/dread/Documents/Island-Bitcoin/Flash/flash/test/flash/unit/services/frappe/BridgeTransferRequestWriter.spec.ts`

**Step 1: Write failing mapper tests**

Cover four mapper functions:

- Bridge deposit → Topup / Fiat Received
- IBEX crypto receive → Topup / Settled
- Bridge transfer completed → Cashout / Completed
- Bridge transfer failed → Cashout / Failed

Each test should mock `ErpNext.upsertBridgeTransferRequest` and assert normalized fields.

**Step 2: Run test to verify failure**

```bash
TEST=test/flash/unit/services/frappe/BridgeTransferRequestWriter.spec.ts yarn test:unit
```

Expected: FAIL because writer does not exist.

**Step 3: Implement writer**

Export functions:

```ts
writeBridgeDepositRequest(args)
writeIbexCryptoReceiveRequest(args)
writeBridgeCashoutCompleted(args)
writeBridgeCashoutFailed(args)
```

Each builds a `BridgeTransferRequest` and calls `ErpNext.upsertBridgeTransferRequest` if `ErpNext` is configured. If ERPNext service is not configured, return a typed error rather than silently succeeding.

**Step 4: Run tests**

```bash
TEST=test/flash/unit/services/frappe/BridgeTransferRequestWriter.spec.ts yarn test:unit
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/services/frappe/BridgeTransferRequestWriter.ts test/flash/unit/services/frappe/BridgeTransferRequestWriter.spec.ts
git commit -m "feat: map Bridge webhooks to ERPNext transfer requests"
```

## Task 6: Wire Bridge deposit webhook

**Files:**
- Modify: `/Users/dread/Documents/Island-Bitcoin/Flash/flash/src/services/bridge/webhook-server/routes/deposit.ts`
- Test: existing/new route test under `/Users/dread/Documents/Island-Bitcoin/Flash/flash/test/flash/unit/services/bridge/webhook-server/routes/deposit.spec.ts`

**Step 1: Write route test**

Mock `writeBridgeDepositRequest`. Assert:

- success path calls writer after `createBridgeDepositLog`
- writer failure returns 500
- duplicate lock still returns 200 without writer call

**Step 2: Run test to verify failure**

```bash
TEST=test/flash/unit/services/bridge/webhook-server/routes/deposit.spec.ts yarn test:unit
```

Expected: FAIL because handler does not call writer.

**Step 3: Implement wiring**

After successful `createBridgeDepositLog`, call `writeBridgeDepositRequest` with fields from `event_id` and `event_object`.

If writer returns Error:

- log `{ error, event_id, id, request_id: id }`
- return `500 { error: "Failed to write ERPNext Bridge Transfer Request" }`

**Step 4: Run test**

```bash
TEST=test/flash/unit/services/bridge/webhook-server/routes/deposit.spec.ts yarn test:unit
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/services/bridge/webhook-server/routes/deposit.ts test/flash/unit/services/bridge/webhook-server/routes/deposit.spec.ts
git commit -m "feat: write ERPNext request for Bridge deposits"
```

## Task 7: Wire IBEX crypto receive webhook

**Files:**
- Modify: `/Users/dread/Documents/Island-Bitcoin/Flash/flash/src/services/ibex/webhook-server/routes/crypto-receive.ts`
- Test: `/Users/dread/Documents/Island-Bitcoin/Flash/flash/test/flash/unit/services/ibex/webhook-server/routes/crypto-receive.spec.ts`

**Step 1: Write route test**

Mock `writeIbexCryptoReceiveRequest`. Assert:

- valid USDT Ethereum receive calls writer with account id, wallet id, tx hash, address, amount
- writer failure returns 500
- invalid payload still returns 400 before writer
- duplicate lock still returns 200 without writer call

**Step 2: Run test to verify failure**

```bash
TEST=test/flash/unit/services/ibex/webhook-server/routes/crypto-receive.spec.ts yarn test:unit
```

Expected: FAIL because handler does not call writer.

**Step 3: Implement wiring**

After `usdtAmount` conversion and before success log/return, call writer.

If writer returns Error:

- log `{ error, tx_hash, accountId, walletId: usdtWallet.id }`
- return `{ status: "error", code: "erpnext_write_failed" }`
- map `erpnext_write_failed` to 500 in `statusMap`

**Step 4: Run test**

```bash
TEST=test/flash/unit/services/ibex/webhook-server/routes/crypto-receive.spec.ts yarn test:unit
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/services/ibex/webhook-server/routes/crypto-receive.ts test/flash/unit/services/ibex/webhook-server/routes/crypto-receive.spec.ts
git commit -m "feat: write ERPNext request for IBEX USDT receives"
```

## Task 8: Wire Bridge transfer webhook

**Files:**
- Modify: `/Users/dread/Documents/Island-Bitcoin/Flash/flash/src/services/bridge/webhook-server/routes/transfer.ts`
- Test: `/Users/dread/Documents/Island-Bitcoin/Flash/flash/test/flash/unit/services/bridge/webhook-server/routes/transfer.spec.ts`

**Step 1: Write route test**

Mock writer functions. Assert:

- `transfer.completed` calls `writeBridgeCashoutCompleted`
- `transfer.failed` calls `writeBridgeCashoutFailed`
- writer failure returns 500
- withdrawal status update failure still returns 500 and does not write ERPNext
- duplicate lock returns 200 without writer call

**Step 2: Run test to verify failure**

```bash
TEST=test/flash/unit/services/bridge/webhook-server/routes/transfer.spec.ts yarn test:unit
```

Expected: FAIL because handler does not call writer.

**Step 3: Implement wiring**

After successful `BridgeAccountsRepo.updateWithdrawalStatus`, call appropriate writer based on event.

If writer returns Error:

- log `{ error, transfer_id, event, request_id: transfer_id }`
- return `500 { error: "Failed to write ERPNext Bridge Transfer Request" }`

**Step 4: Run test**

```bash
TEST=test/flash/unit/services/bridge/webhook-server/routes/transfer.spec.ts yarn test:unit
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/services/bridge/webhook-server/routes/transfer.ts test/flash/unit/services/bridge/webhook-server/routes/transfer.spec.ts
git commit -m "feat: write ERPNext requests for Bridge cashouts"
```

## Task 9: Run focused backend verification

**Files:**
- No new files unless fixing discovered issues.

**Step 1: Run focused tests**

```bash
cd /Users/dread/Documents/Island-Bitcoin/Flash/flash
TEST='test/flash/unit/services/frappe|test/flash/unit/services/bridge|test/flash/unit/services/ibex/webhook-server/routes/crypto-receive.spec.ts' yarn test:unit
```

Expected: PASS.

**Step 2: Run typecheck/build**

```bash
yarn tsc-check
```

If this repo normally requires generated files/build instead, run:

```bash
yarn build
```

Expected: PASS.

**Step 3: Commit fixes if needed**

```bash
git status --short
# If fixes were needed:
git add <files>
git commit -m "fix: satisfy ENG-348 verification"
```

## Task 10: Document operational behavior

**Files:**
- Modify: `/Users/dread/Documents/Island-Bitcoin/Flash/flash/docs/bridge-integration/WEBHOOKS.md` if present in branch, or add note to `docs/plans/2026-05-09-eng-348-erpnext-bridge-transfer-request-design.md` if docs are not on implementation branch.

**Step 1: Update docs**

Document:

- `Bridge Transfer Request` is written by Bridge deposit, IBEX receive, and Bridge transfer webhooks.
- ERPNext write failure returns 500 for retry.
- Missing ERPNext records are ENG-348 bugs and should be visible in ENG-362 panel.

**Step 2: Commit**

```bash
git add docs/bridge-integration/WEBHOOKS.md docs/plans/2026-05-09-eng-348-erpnext-bridge-transfer-request-design.md
git commit -m "docs: describe ENG-348 ERPNext audit behavior"
```

## Final Verification Checklist

- Frappe DocType JSON validates.
- Frappe DocType has unique `request_id`.
- Backend model tests pass.
- ERPNext upsert tests pass.
- Writer mapping tests pass.
- Deposit route writer test passes.
- Crypto receive route writer test passes.
- Transfer route writer test passes.
- Backend typecheck/build passes.
- Design and operational docs are committed.
