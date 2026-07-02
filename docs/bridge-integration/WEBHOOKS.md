# Bridge.xyz Webhook Handling

Flash receives real-time updates from Bridge.xyz via webhooks. These webhooks are used to update KYC status, confirm deposits, and track withdrawal progress.

## Webhook Endpoint

The webhook server listens on the configured port (default: `4009`) and expects POST requests at the following endpoints:

-   `POST /kyc`
-   `POST /deposit`
-   `POST /transfer`
-   `POST /external-account`

## Signature Verification

All incoming webhooks from Bridge.xyz are signed using asymmetric RSA-SHA256. Flash verifies these signatures using the public keys provided by Bridge.xyz.

### Verification Process

1.  Retrieve the signature header from `X-Webhook-Signature`.
2.  Parse the timestamp and signature from the header format: `t=<timestamp_ms>,v0=<base64_signature>`.
3.  Verify that the timestamp is within the allowed skew (default: 5 minutes) to prevent replay attacks.
4.  Construct the signed payload by concatenating the timestamp and the exact raw request body: `timestamp + "." + rawBody`.
5.  Hash the signed payload with SHA-256.
6.  Verify the Base64 `v0` signature against that digest using RSA-SHA256 and the appropriate Bridge public key (KYC, Deposit, Transfer, or External Account).

Flash must verify against the raw body captured before JSON parsing. Re-serializing the parsed JSON body changes the signed bytes and must fail signature verification.

## Event Types

### KYC Events

#### `kyc.approved`
Sent when a user's KYC application is approved.
-   **Action**: Update user's `bridgeKycStatus` to `approved`.

#### `kyc.rejected`
Sent when a user's KYC application is rejected.
-   **Action**: Update user's `bridgeKycStatus` to `rejected`.

### Deposit Events

#### `deposit.completed`
Sent when a USD deposit to a virtual account is successfully converted to USDT and sent to the user's on-chain address.
-   **Action**: This event is primarily for tracking. The actual crediting of the user's wallet is handled by the IBEX webhook when the USDT arrives.

### Transfer Events

#### `transfer.completed`
Sent when an off-ramp transfer (USDT -> USD) is successfully completed.
-   **Action**: Update the withdrawal record status to `completed` and notify the user.

#### `transfer.failed`
Sent when an off-ramp transfer fails.
-   **Action**: Update the withdrawal record status to `failed`, record the reason, and notify the user.

## Idempotency Handling

Each webhook event includes a unique `id`. Flash ensures that each event is processed exactly once by:

1.  Checking if the event ID has already been processed in the database.
2.  Using a distributed lock (Redis) during processing to prevent race conditions from duplicate deliveries.

## Response Codes

-   `200 OK`: Event successfully processed or already processed.
-   `400 Bad Request`: Invalid payload or missing headers.
-   `401 Unauthorized`: Signature verification failed.
-   `500 Internal Server Error`: Temporary failure; Bridge.xyz will retry the webhook.
