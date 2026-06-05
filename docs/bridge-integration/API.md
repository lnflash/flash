# Bridge.xyz GraphQL API Reference

All Bridge-related operations require the user to be authenticated and have an **Account Level 1** or higher.

## Mutations

### `bridgeInitiateKyc`

Starts the KYC process for the authenticated user.

**Request:**
```graphql
mutation BridgeInitiateKyc {
  bridgeInitiateKyc {
    errors {
      message
    }
    kycLink {
      kycLink
      tosLink
    }
  }
}
```

**Response:**
- `kycLink`: URL to the Bridge/Persona KYC flow.
- `tosLink`: URL to the Bridge Terms of Service.

---

### `bridgeCreateVirtualAccount`

Creates a virtual bank account for the user to receive USD deposits. Requires approved KYC.

**Request:**
```graphql
mutation BridgeCreateVirtualAccount {
  bridgeCreateVirtualAccount {
    errors {
      message
    }
    virtualAccount {
      bridgeVirtualAccountId
      bankName
      routingNumber
      accountNumberLast4
    }
  }
}
```

**Response:**
- `bridgeVirtualAccountId`: Unique identifier for the virtual account.
- `bankName`: Name of the bank (e.g., "Bridge Bank").
- `routingNumber`: ABA routing number.
- `accountNumberLast4`: Last 4 digits of the account number.

---

### `bridgeAddExternalAccount`

Returns a hosted URL for the user to link their external bank account (via Plaid/Bridge).

**Request:**
```graphql
mutation BridgeAddExternalAccount {
  bridgeAddExternalAccount {
    errors {
      message
    }
    externalAccount {
      linkUrl
      expiresAt
    }
  }
}
```

**Response:**
- `linkUrl`: URL to the bank linking flow.
- `expiresAt`: Expiration timestamp for the link.

---

### `bridgeRequestWithdrawal`

Validates a withdrawal and creates a pending record for the confirmation screen. Does **not** call the Bridge API. If an identical pending request already exists (same account, amount, and external account), the existing record is returned.

**Request:**
```graphql
mutation BridgeRequestWithdrawal($input: BridgeRequestWithdrawalInput!) {
  bridgeRequestWithdrawal(input: $input) {
    errors {
      message
    }
    withdrawal {
      id
      amount
      currency
      externalAccountId
      status
      createdAt
    }
  }
}
```

**Input:**
- `amount`: String representation of the amount (e.g., "100.00"). Must be positive with at most 6 decimal places and above the configured minimum.
- `externalAccountId`: The ID of the linked bank account.

**Response:**
- `id`: MongoDB withdrawal record ID — pass this to `bridgeInitiateWithdrawal` or `bridgeCancelWithdrawalRequest`.
- `status`: Always `"pending"` on success.
- `externalAccountId`: Linked bank account used for the withdrawal.

---

### `bridgeInitiateWithdrawal`

Submits a previously requested withdrawal to Bridge. Re-checks USDT balance at execution time.

**Request:**
```graphql
mutation BridgeInitiateWithdrawal($input: BridgeInitiateWithdrawalInput!) {
  bridgeInitiateWithdrawal(input: $input) {
    errors {
      message
    }
    withdrawal {
      id
      amount
      currency
      status
      createdAt
    }
  }
}
```

**Input:**
- `withdrawalId`: The `id` returned by `bridgeRequestWithdrawal`.

**Response:**
- `id`: Withdrawal record ID.
- `status`: Withdrawal status after Bridge transfer creation (typically `"pending"` until the webhook settles).

**Errors:**
- `BridgeWithdrawalNotFoundError`: Withdrawal ID does not exist or belongs to another account.
- `BridgeWithdrawalAlreadyInitiatedError`: Withdrawal was already submitted to Bridge.
- `BridgeInsufficientFundsError`: Balance dropped between request and confirm.

---

### `bridgeCancelWithdrawalRequest`

Cancels a pending withdrawal before it has been submitted to Bridge.

**Request:**
```graphql
mutation BridgeCancelWithdrawalRequest($input: BridgeCancelWithdrawalRequestInput!) {
  bridgeCancelWithdrawalRequest(input: $input) {
    errors {
      message
    }
    withdrawal {
      id
      amount
      currency
      status
      createdAt
    }
  }
}
```

**Input:**
- `withdrawalId`: The `id` returned by `bridgeRequestWithdrawal`.

**Response:**
- `status`: `"cancelled"` on success.

**Errors:**
- `BridgeWithdrawalNotFoundError`: Withdrawal ID does not exist or belongs to another account.
- `BridgeWithdrawalAlreadyInitiatedError`: Transfer was already submitted to Bridge and cannot be cancelled.

---

## Queries

### `bridgeKycStatus`

Returns the current KYC status for the user.

**Request:**
```graphql
query BridgeKycStatus {
  bridgeKycStatus
}
```

**Possible Values:**
- `"pending"`: KYC is in progress.
- `"approved"`: KYC is complete and approved.
- `"rejected"`: KYC was rejected.
- `null`: KYC has not been initiated.

---

### `bridgeVirtualAccount`

Returns the user's virtual account details if one exists.

**Request:**
```graphql
query BridgeVirtualAccount {
  bridgeVirtualAccount {
    bridgeVirtualAccountId
    bankName
    routingNumber
    accountNumberLast4
  }
}
```

---

### `bridgeExternalAccounts`

Lists all linked external bank accounts.

**Request:**
```graphql
query BridgeExternalAccounts {
  bridgeExternalAccounts {
    bridgeExternalAccountId
    bankName
    accountNumberLast4
    status
  }
}
```

---

### `bridgeWithdrawalRequest`

Fetches a single withdrawal record by ID for the confirmation screen. Returns `null` if the ID does not exist or belongs to another account (no cross-account leakage).

**Request:**
```graphql
query BridgeWithdrawalRequest($id: ID!) {
  bridgeWithdrawalRequest(id: $id) {
    id
    amount
    currency
    externalAccountId
    status
    failureReason
    createdAt
  }
}
```

---

### `bridgeWithdrawals`

Lists the user's withdrawal history (submitted transfers only).

**Request:**
```graphql
query BridgeWithdrawals {
  bridgeWithdrawals {
    id
    amount
    currency
    status
    bridgeTransferId
    failureReason
    createdAt
  }
}
```

## Error Codes

| Code | Description |
| --- | --- |
| `BRIDGE_DISABLED` | Bridge integration is disabled in configuration. |
| `BRIDGE_ACCOUNT_LEVEL_ERROR` | User account level is below 1. |
| `BRIDGE_INVALID_AMOUNT` | Withdrawal amount is malformed or not positive. |
| `BRIDGE_BELOW_MINIMUM_WITHDRAWAL` | Withdrawal amount is below the configured minimum. |
| `BRIDGE_KYC_PENDING` | Operation requires approved KYC, but it is still pending. |
| `BRIDGE_KYC_REJECTED` | KYC was rejected. |
| `BRIDGE_KYC_OFFBOARDED` | Bridge offboarded the customer. |
| `BRIDGE_KYC_TIER_CEILING_EXCEEDED` | Withdrawal amount exceeds the KYC tier ceiling. |
| `BRIDGE_CUSTOMER_NOT_FOUND` | Bridge customer record not found for the user. |
| `BRIDGE_WITHDRAWAL_NOT_FOUND` | Withdrawal request not found or does not belong to the caller. |
| `BRIDGE_WITHDRAWAL_ALREADY_INITIATED` | Withdrawal was already submitted to Bridge. |
| `BRIDGE_INSUFFICIENT_FUNDS` | USDT balance is insufficient for the withdrawal. |
| `BRIDGE_RATE_LIMIT` | Bridge rate-limited the request. |
| `BRIDGE_TIMEOUT` | Bridge request timed out. |
| `BRIDGE_TRANSFER_FAILED` | Bridge transfer failed. |
| `BRIDGE_WEBHOOK_VALIDATION` | Bridge webhook signature validation failed. |
| `BRIDGE_API_ERROR` | Bridge API returned an unclassified provider error. |
| `BRIDGE_ERROR` | Unclassified Bridge domain error. |
