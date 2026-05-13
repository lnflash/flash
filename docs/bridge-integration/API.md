# Bridge.xyz GraphQL API Reference

All Bridge-related operations require the user to be authenticated and have an **Account Level 2** or higher.

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

### `bridgeInitiateWithdrawal`

Initiates a withdrawal from the user's USDT balance to a linked external bank account.

**Request:**
```graphql
mutation BridgeInitiateWithdrawal($input: BridgeInitiateWithdrawalInput!) {
  bridgeInitiateWithdrawal(input: $input) {
    errors {
      message
    }
    withdrawal {
      transferId
      amount
      currency
      state
    }
  }
}
```

**Input:**
- `amount`: String representation of the amount (e.g., "100.00").
- `externalAccountId`: The ID of the linked bank account.

**Response:**
- `transferId`: Unique identifier for the transfer.
- `state`: Current state of the transfer (e.g., "pending", "processing").

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

### `bridgeWithdrawals`

Lists the user's withdrawal history.

**Request:**
```graphql
query BridgeWithdrawals {
  bridgeWithdrawals {
    transferId
    amount
    currency
    state
    createdAt
  }
}
```

## Error Codes

| Code | Description |
| --- | --- |
| `BRIDGE_DISABLED` | Bridge integration is disabled in configuration. |
| `BRIDGE_ACCOUNT_LEVEL_ERROR` | User account level is below 2. |
| `BRIDGE_KYC_PENDING` | Operation requires approved KYC, but it is still pending. |
| `BRIDGE_KYC_REJECTED` | KYC was rejected. |
| `BRIDGE_CUSTOMER_NOT_FOUND` | Bridge customer record not found for the user. |
