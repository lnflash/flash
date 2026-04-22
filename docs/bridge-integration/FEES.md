# Bridge.xyz Integration — Fees

> What Bridge charges, what Flash *could* charge on top, and what the code
> actually charges today (**zero**). Most numbers here are **TBD** until
> commercial terms with Bridge are pinned and product decides on markup.

## 1. Fee surfaces

There are four places a fee could be levied along the Bridge path:

1. **Bridge platform fee** — what Bridge charges Flash per transfer / per
   virtual account. Set by the Bridge commercial contract.
2. **Bridge developer fee** — an *optional* markup Flash can ask Bridge to
   collect on top, exposed via `developer_fee_percent` /
   `developer_fee` fields on Bridge's `transfers` and `virtual_accounts`
   APIs.
3. **Network / on-chain fee** — gas paid to settle USDT-on-Ethereum.
   Borne by IBEX (deposit side) or by Bridge (off-ramp side, baked into
   their quote).
4. **FX / spread** — the implicit cost of converting between USD ↔ USDT
   ↔ JMD. Not directly billed; manifests as an unfavourable rate.

## 2. What Flash charges today

**Nothing.** Verified by reading `svc-index.ts` against
`svc-client.ts`:

- `BridgeClient.CreateVirtualAccountRequest` has a
  `developer_fee_percent?: string` field (svc-client.ts §line 102).
- `BridgeClient.CreateTransferRequest` has both
  `developer_fee_percent?: string` and `developer_fee?: string` (lines
  166–167).
- `BridgeService.createVirtualAccount` does **not** populate
  `developer_fee_percent` when calling `client.createVirtualAccount`.
- `BridgeService.initiateWithdrawal` does **not** populate
  `developer_fee_percent` or `developer_fee` when calling
  `client.createTransfer`.

So every Bridge call goes out fee-free from Flash's perspective. Whatever
Bridge bills Flash internally is what Flash absorbs; Flash makes no
margin on the rail today.

There is also no Flash-side fee deducted from the USDT wallet before the
withdrawal is sent — the user receives `(amount - Bridge's internal
fees)` at the bank, and Flash's books reflect a full-`amount` debit from
the wallet.

## 3. Bridge contract fees (TBD)

> **TBD — pin once contract is signed.** Placeholders below.

### 3.1 Per-transfer

| Rail | Fixed | Variable | Notes |
|---|---|---|---|
| ACH push (off-ramp) | TBD | TBD bps | Phase-1 default. |
| Wire | TBD | TBD bps | Not in Phase 1. |
| USDT-on-Ethereum receive | TBD | TBD bps | Bridge sees inbound USDT; charges to convert to USD held in virtual account. |

### 3.2 Per-virtual-account

| Item | Bridge fee (TBD) | Notes |
|---|---|---|
| Account creation | TBD | One-off. |
| Monthly maintenance | TBD | Recurring. |
| Inactive-account fee | TBD | If applicable. |

### 3.3 KYC / onboarding

| Item | Bridge fee (TBD) | Notes |
|---|---|---|
| Persona KYC submission | TBD | Per-attempt vs per-success unclear. |
| Plaid bank-link verification | TBD | Same. |
| Re-verification on tier upgrade | TBD | Same. |

### 3.4 Failure / chargeback

| Item | Bridge fee (TBD) | Notes |
|---|---|---|
| ACH return | TBD | Likely passthrough + Bridge surcharge. |
| Wire recall | TBD | Same. |
| Disputed transfer | TBD | Same. |

## 4. Flash markup options (proposed — TBD)

Two independent levers exist:

### 4.1 Bridge `developer_fee` (collected by Bridge)

Pros:
- No reconciliation work — Bridge takes it on top of the transfer and
  remits to Flash.
- No risk of double-charging.

Cons:
- Visible to the user as part of the Bridge quote, not as a Flash line
  item.
- Bridge controls disclosure language.
- Code change required to populate the field — currently unset.

### 4.2 Flash-side fee (deducted from USDT wallet pre-transfer)

Pros:
- Full control over UX disclosure.
- Independent of Bridge's pricing.
- Can be tiered per account level / per rail / per amount.

Cons:
- Requires new ledger entries (debit USDT wallet for fee, credit Flash
  revenue account).
- Must be reflected in the "amount you'll receive" preview shown in
  the app — currently no such preview.
- Reconciliation burden.

**No decision yet.** Recommend deferring until §3 numbers are pinned, so
markup can be calibrated to net margin rather than guessed.

## 5. FX & spread

- **USD ↔ USDT** at deposit time: handled inside Bridge's virtual
  account; no Flash exposure.
- **USDT ↔ USD** at off-ramp time: Bridge quotes the conversion as
  part of the transfer; the `amount` passed to `createTransfer` is in
  USDT, the bank receives USD. Flash sees the implied rate only via
  Bridge's response, which is **not currently surfaced** to the user
  or stored on the `bridgeWithdrawals` row.
- **USD ↔ JMD** for Cashout V1: handled by the existing ERPNext
  Cashout DocType + manual RTGS workflow; **out of scope** for the
  Bridge integration. See FLOWS §6.

> **Gap:** no FX rate is captured on the withdrawal record. If Bridge's
> quote moves between user-quote-time and submit-time, there is no audit
> trail. Tracked under (new ticket).

## 6. Reconciliation expectations

| Source | Field | Used for |
|---|---|---|
| Bridge `GET /transfers/:id` response | `amount`, `fee`, `developer_fee` | Should be persisted onto `bridgeWithdrawals` to support per-transaction P&L. **Currently not persisted** — only `amount`/`status`/`bridgeTransferId` are stored. |
| Bridge invoice (monthly) | Aggregate | Compare to sum of `bridgeWithdrawals.amount` × negotiated rate. |
| Network gas | n/a | Bridge absorbs; not billed line-by-line. |

**Gap:** there is no `fee` column on the `bridgeWithdrawals` schema
today (see mongoose-schema.ts §`IBridgeWithdrawalRecord`). Adding it is
a prerequisite to any meaningful FCA / finance reconciliation.

## 7. What the user sees today

- **Quote screen:** none — the user enters an amount and submits.
- **Confirmation screen:** none — there is no "you'll receive
  $X after $Y in fees" display.
- **History row:** shows `amount` and `status`. No fee breakdown.
- **Push notification:** not yet implemented (ENG-275).

This is a **product gap** as much as an engineering one. Even if Flash
charges nothing, the user should see Bridge's deduction so the bank
deposit doesn't look like an error.

## 8. Open work

| Item | Owner | Tracking |
|---|---|---|
| Pin Bridge contract fees (§3) | Eng + Bridge sales | (new ticket) |
| Decide markup model (§4.1 vs §4.2 vs none) | Product + Finance | (new ticket) |
| Add `fee` / `developerFee` / `fxRate` columns to `bridgeWithdrawals` | Eng | (new ticket) |
| Persist Bridge's `fee` from `GET /transfers/:id` response | Eng | depends on schema change above |
| Add quote / confirmation UX showing Bridge deduction | Mobile + Product | (new ticket) |
| Min-withdrawal floor so fees don't swamp principal | Product → Eng | also in LIMITS §6 |

## Document History

| Date | Author | Change |
|---|---|---|
| 2026-04-22 | Taddesse (Dread review) | Initial fees doc; honestly labels TBDs and the zero-charge state of the code today. |
