# Bridge.xyz Integration Flows

This document describes the step-by-step flows for USD on-ramp and off-ramp using Bridge.xyz and IBEX.

## On-Ramp Flow (USD -> USDT)

This flow allows users to deposit USD from their bank account and receive USDT in their Flash wallet.

### Sequence Diagram

```ascii
User            Flash App          Flash Backend          Bridge.xyz             IBEX
 |                  |                   |                     |                   |
 | 1. Start KYC     |                   |                     |                   |
 |----------------->| 2. bridgeInitKyc  |                     |                   |
 |                  |------------------>| 3. Create Customer  |                   |
 |                  |                   |-------------------->|                   |
 |                  |                   | 4. Create KYC Link  |                   |
 |                  |                   |-------------------->|                   |
 |                  | 5. KYC Link       |                     |                   |
 |                  |<------------------|                     |                   |
 | 6. Complete KYC  |                   |                     |                   |
 |----------------->|                   |                     |                   |
 | (Persona Flow)   |                   |                     |                   |
 |                  |                   | 7. kyc.approved     |                   |
 |                  |                   |<--------------------|                   |
 |                  |                   | 8. Create USDT Addr |                   |
 |                  |                   |---------------------------------------->|
 |                  |                   | 9. Create Virt Acc  |                   |
 |                  |                   |-------------------->|                   |
 | 10. View Bank Det|                   |                     |                   |
 |<-----------------|                   |                     |                   |
 | 11. Transfer USD |                   |                     |                   |
 |----------------------------------------------------------->|                   |
 |                  |                   |                     | 12. Convert USD   |
 |                  |                   |                     | 13. Send USDT     |
 |                  |                   |                     |------------------>|
 |                  |                   |                     |                   |
 |                  |                   | 14. Crypto Webhook  |                   |
 |                  |                   |<----------------------------------------|
 |                  | 15. Notify User   |                     |                   |
 |<-----------------|                   |                     |                   |
```

### Steps

1.  **Initiate KYC**: User clicks "Deposit USD" in the app.
2.  **GraphQL Mutation**: App calls `bridgeInitiateKyc`.
3.  **Bridge Customer**: Flash creates a Bridge customer if one doesn't exist.
4.  **KYC Link**: Flash requests a KYC link from Bridge.
5.  **Redirect**: App opens the KYC link (Persona).
6.  **Verification**: User completes identity verification.
7.  **KYC Webhook**: Bridge sends `kyc.approved` webhook to Flash.
8.  **USDT Address**: Flash requests a unique USDT receive address from IBEX.
9.  **Virtual Account**: Flash creates a Bridge virtual account linked to the receive address.
10. **Display Details**: User sees bank name, routing number, and account number in the app.
11. **Bank Transfer**: User initiates a transfer from their banking app.
12. **Conversion**: Bridge receives USD and converts it to USDT.
13. **Settlement**: Bridge sends USDT to the user's on-chain address.
14. **IBEX Webhook**: IBEX detects the incoming USDT and notifies Flash.
15. **Credit**: Flash credits the user's USDT wallet and sends a push notification.

---

## Off-Ramp Flow (USDT -> USD)

This flow allows users to withdraw USDT from their Flash wallet to their external bank account.

### Sequence Diagram

```ascii
User            Flash App          Flash Backend          Bridge.xyz             Bank
 | (Check for KYC, if complete, skip to 12.                   |                   |
 | 1. Start KYC     |                   |                     |                   |
 |----------------->| 2. bridgeInitKyc  |                     |                   |
 |                  |------------------>| 3. Create Customer  |                   |
 |                  |                   |-------------------->|                   |
 |                  |                   | 4. Create KYC Link  |                   |
 |                  |                   |-------------------->|                   |
 |                  | 5. KYC Link       |                     |                   |
 |                  |<------------------|                     |                   |
 | 6. Complete KYC  |                   |                     |                   |
 |----------------->|                   |                     |                   |
 | (Persona Flow)   |                   |                     |                   |
 |                  |                   | 7. kyc.approved     |                   |
 |                  |                   |<--------------------|                   |
 | 8. Link Bank     |                   |                     |                   |
 |----------------->| 9. bridgeAddExtAcc|                     |                   |
 |                  |------------------>| 10. Get Link URL    |                   |
 |                  |                   |-------------------->|                   |
 |                  | 11. Link URL      |                     |                   |
 |                  |<------------------|                     |                   |
 | 12. Auth Bank    |                   |                     |                   |
 |----------------->|                   |                     |                   |
 | (Plaid Flow)     |                   |                     |                   |
 |                  |                   | 13. ext_acc.verified|                   |
 |                  |                   |<--------------------|                   |
 | 14. Withdraw     |                   |                     |                   |
 |----------------->| 15. bridgeRequest |                     |                   |
 |                  |     Withdrawal    |                     |                   |
 |                  |------------------>| 16. Store pending   |                   |
 |                  | 17. Confirm screen|     withdrawal      |                   |
 |                  |<------------------|                     |                   |
 | 18. Confirm      |                   |                     |                   |
 |----------------->| 19. bridgeInitWith|                     |                   |
 |                  |     (withdrawalId)| 20. Create Transfer |                   |
 |                  |------------------>|-------------------->|                   |
 |                  | 21. Pending       |                     |                   |
 |<-----------------|                   |                     |                   |
 |                  |                   |                     | 22. Convert USDT  |
 |                  |                   |                     | 23. Send ACH      |
 |                  |                   |                     |------------------>|
 |                  |                   | 24. trans.completed |                   |
 |                  |                   |<--------------------|                   |
 | 25. Funds Arrive |                   |                     |                   |
 |<-------------------------------------------------------------------------------|
```

### Steps

1.  **Link Bank**: User chooses to add a bank account.
2.  **GraphQL Mutation**: App calls `bridgeAddExternalAccount`.
3.  **Link URL**: Flash requests a hosted link URL from Bridge.
4.  **Redirect**: App opens the Bridge/Plaid flow.
5.  **Authentication**: User logs into their bank and selects an account.
6.  **Verification Webhook**: Bridge notifies Flash when the external account is verified.
7.  **Request Withdrawal**: User enters amount and selects the linked bank account.
8.  **GraphQL Mutation**: App calls `bridgeRequestWithdrawal` with `amount` and `externalAccountId`.
9.  **Validation**: Flash checks USDT balance, account level, and external account ownership/verification. A `pending` withdrawal record is stored in MongoDB. If an identical pending request already exists (same account, amount, and bank account), the existing record is reused.
10. **Confirmation Screen**: App fetches the pending withdrawal via `bridgeWithdrawalRequest(id)` and displays amount, bank account, and fees for user review.
11. **User Confirms or Cancels**:
    - **Confirm**: App calls `bridgeInitiateWithdrawal` with `withdrawalId`. Flash re-checks balance, then creates a transfer in Bridge from the user's Ethereum USDT address to the external account.
    - **Cancel**: App calls `bridgeCancelWithdrawalRequest` with `withdrawalId`. The pending record is marked `cancelled` and a push notification is sent.
12. **Pending State**: After initiation, app shows the withdrawal as "Pending".
13. **Conversion**: Bridge converts USDT from the user's balance to USD.
14. **ACH Transfer**: Bridge sends USD to the user's bank via ACH.
15. **Transfer Webhook**: Bridge sends `transfer.completed` (or failure) webhook to Flash.
16. **Completion**: User receives funds in their bank account (usually 1-3 business days).

## Fee Structure

-   **Bridge Fees**: Bridge.xyz charges fees for conversion and transfers (see Bridge.xyz documentation for current rates).
-   **Flash Fee**: Flash charges a **0.5%** service fee on all Bridge transactions, which is included in the total amount shown to the user.
