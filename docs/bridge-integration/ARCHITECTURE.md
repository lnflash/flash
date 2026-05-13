# Bridge.xyz Integration Architecture

## System Overview

The Bridge.xyz integration enables USD on-ramp and off-ramp functionality for Flash users. It allows users to convert between USD (via bank transfers) and USDT (on the Tron network), which is then integrated into the Flash ecosystem via IBEX.

## Component Architecture

The integration consists of three main components:

1.  **Flash Backend**: The core service that orchestrates the flow between users, Bridge.xyz, and IBEX. It exposes a GraphQL API for the mobile app and handles webhooks from Bridge.xyz.
2.  **Bridge.xyz API**: An external service that provides virtual bank accounts, KYC processing, and USD/USDT conversion.
3.  **IBEX**: An external service used by Flash to manage Bitcoin and Lightning wallets, and in this context, to provide Tron USDT receive addresses and handle USDT deposits.

### Component Diagram

```ascii
+-------------+       GraphQL       +----------------+
|  Mobile App | <-----------------> | Flash Backend  |
+-------------+                     +----------------+
                                      ^          ^
                                      |          |
                                      | API      | API
                                      v          v
                               +------------+  +------------+
                               | Bridge.xyz |  |    IBEX    |
                               +------------+  +------------+
                                      |               |
                                      | USD/USDT      | USDT
                                      v               v
                               +----------------------------+
                               |       Tron Network         |
                               +----------------------------+
```

## Data Flow

### On-Ramp (USD -> USDT)

1.  **KYC**: User initiates KYC via Flash, which creates a Bridge customer and returns a KYC link (Persona).
2.  **Virtual Account**: Once KYC is approved, Flash creates a Tron USDT address via IBEX and a Bridge virtual account pointing to that address.
3.  **Deposit**: User sends USD to the virtual account.
4.  **Conversion**: Bridge converts USD to USDT and sends it to the Tron address.
5.  **Credit**: IBEX detects the USDT deposit and notifies Flash via webhook, which credits the user's wallet.

### Off-Ramp (USDT -> USD)

1.  **Link Bank**: User links an external bank account via Bridge's hosted UI.
2.  **Withdrawal**: User initiates a withdrawal in Flash.
3.  **Transfer**: Flash creates a Bridge transfer from the user's Tron address to the linked bank account.
4.  **Conversion**: Bridge converts USDT to USD and sends it to the bank via ACH.

## Technology Stack

-   **Language**: TypeScript
-   **Runtime**: Node.js
-   **API**: GraphQL (Apollo Server)
-   **Database**: MongoDB (Mongoose) for storing Bridge account mappings and transfer states.
-   **Communication**: REST API (Bridge.xyz), Webhooks.

## Security Model

-   **Account Level**: Bridge functionality is restricted to users with Account Level 2 or higher.
-   **KYC**: All users must pass Bridge's KYC process (powered by Persona).
-   **Webhook Verification**: All incoming webhooks from Bridge.xyz are verified using asymmetric RSA-SHA256 signatures.
-   **Idempotency**: All critical API calls to Bridge include an `Idempotency-Key` to prevent duplicate transactions.
-   **Data Isolation**: Bridge customer IDs and account details are mapped to Flash internal account IDs.
