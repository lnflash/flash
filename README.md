# Flash 

[![Twitter Follow](https://img.shields.io/twitter/follow/LNFlash?style=social)](https://twitter.com/LNFlash)
[![GitHub Repo stars](https://img.shields.io/github/stars/lnflash/flash?style=social)](https://github.com/lnflash/flash/stargazers)
### 💡 Get help
[Q&A](https://github.com/GaloyMoney/galoy/discussions) or [Mattermost 💬](https://chat.galoy.io)

### TLDR

Flash is an opinionated bitcoin banking platform forked from Galoy.

This repo represents the main api that brings all functionality together.
Take a look at the [Quickstart](./quickstart) if you want to take it for a spin.

### Responsible disclosure 

Found critical bugs/vulnerabilities?
Please email them security@galoy.io Thanks!

### Get Started

Want to try it out and contribute? Checkout the [dev documentation](./DEV.md) to deploy locally with a docker compose script.

For an overview of the Flash enhancement methodology, see [AZ-RSP (Absolute Zero Reinforced Self-Play)](./ABSOLUTE_ZERO_METHOD.md), our approach to systematic feature development and verification.

If you have questions, you can [join our Workspace](https://chat.galoy.io)

For an overview of all relevant repository checkout [awesome-galoy](https://github.com/GaloyMoney/awesome-galoy).
### Galoy-Backend features

- GraphqlAPI:
  - Public API following industry best practices
  - For [end clients](./src/graphql/public/schema.graphql). [Documentation](https://galoymoney.github.io/galoy/)
  - For [admin activities](./src/graphql/admin/schema.graphql)
- Authentication:
  - Code is sent via twillio to end users phone number which can be exchanged for jwt auth token
  - OAuth integration (in progress)
  - Account scoped API keys with comprehensive management system
- Internal ledger:
  - Records all account activity via double entry accounting
  - Support for integrating fiat currencies (in progress)
  - CSV based export of all accounting data
- Contact list for frequent transaction partners
- Price
  - Sub-second [price data](https://github.com/GaloyMoney/price) polled from largest exchanges to record USD value at settlement
  - Historical price data can be queried for display for different time frames
- Send / Receive BTC payments
  - External settlement via OnChain or lightning
  - Automatic internal settlement when payer & payee are on the same galoy instance
  - Fees can be applied for sending / receiving for all settlement methods
  - Support for tipping via [dedicated web-frontend](https://github.com/GaloyMoney/galoy-pay)
  - Include memo to payment
- Lightning Network
  - Support for clearnet and TOR
  - Support for invoices with and without specified amount
  - Route probing to pre-display an accurate fee and mitigate attacks based on expensive routing
  - Channel data backup to dropbox and google cloud storage
- Custodial storage of all user assets
  - Limited funds stored in hot-wallet (keys kept on servers)
  - Threshold based rebalancing to cold-storage (keys stored on offline hardware devices)
- Security:
  - [Velocity check](https://www.linkedin.com/pulse/velocity-checks-fraud-prevention-scott-stone/) based on user verification level
  - Spam protection for sharing memos
  - Configurable 2fa for payments (in progress)
  - Advanced API key management with scope-based permissions
  - DDos prevention
    - via adaptive rate limiting with suspicious activity detection
    - via geetest CAPTCHA
  - Secure webhook authentication with signature verification
- Resilience
  - Databases (mongodb and redis) are run by default in high availability/resilience mode. If one pod/node goes down, there is an automatic failover on another pod/node.
- Production ready
  - Supports horizontal scaling and highly available deployments via k8s
  - Client side load balancing across multiple LND nodes
  - Out-of-the-box dashboards for KPIs deployed to grafana showing metrics exported via prometheus
  - Quick response times thanks to pagination of large data sets
  - Returning error codes for full translation capability of the frontend
  - Instrumentation enabled for real-time insights into production runtime ([opentelemetry](https://opentelemetry.io) / [honeycomb](https://www.honeycomb.io))
- User on-boarding (optional)
  - Gamification via user quiz that pays out sats
  - Map of in-network merchants
- Notifications
  - Mobile clients can receive notifications of balance changes in real-time
  - Daily notification of balance for active end users

### API Key Management System

Flash includes a comprehensive API key management system that enables third-party developers to securely access the GraphQL API. This system provides fine-grained control over permissions and implements advanced security features.

#### Key Features

- **Secure Key Generation**: Cryptographically secure, randomly generated API keys with prefixes for key type identification
- **Scope-Based Permissions**: Granular access control with customizable scopes for different API operations
- **Adaptive Rate Limiting**: Intelligent rate limiting that adjusts based on usage patterns and detects suspicious activity
- **Zero-Downtime Key Rotation**: Seamless key rotation with configurable transition periods
- **Comprehensive Logging**: Detailed audit logs for all API key operations and usage
- **Developer Dashboard**: Self-service portal for developers to manage their API keys

#### Usage Instructions

##### Obtaining an API Key

API keys can be obtained through the developer dashboard or by contacting the Flash administrators. Each key is associated with specific scopes that determine the allowed operations.

##### Authentication

To authenticate API requests, include the API key in the HTTP Authorization header:

```
Authorization: ApiKey flash_live_xxxxxxxxxxxxxxxxxxxxx
```

Alternatively, you can pass the API key as a query parameter (less secure):

```
https://api.flash.com/graphql?apiKey=flash_live_xxxxxxxxxxxxxxxxxxxxx
```

##### Making GraphQL Requests

Once authenticated, you can make GraphQL requests to the API. The available operations are determined by the scopes associated with your API key.

Example GraphQL query:

```graphql
query GetWalletBalance {
  me {
    defaultAccount {
      wallets {
        id
        balance
        currency
      }
    }
  }
}
```

Requests are subject to rate limits based on your API key's tier and usage patterns.

##### Understanding Rate Limits

The API employs adaptive rate limiting that adjusts based on usage patterns. The following headers are included in API responses:

- `X-RateLimit-Limit`: Maximum number of requests allowed in the current period
- `X-RateLimit-Remaining`: Number of requests remaining in the current period
- `X-RateLimit-Reset`: Time when the rate limit resets (Unix timestamp)
- `X-RateLimit-Used`: Number of requests made in the current period

If you exceed your rate limit, you'll receive a 429 (Too Many Requests) response.

##### Key Rotation

For security purposes, API keys should be rotated regularly. The API key management system supports zero-downtime key rotation:

1. Generate a new API key through the developer dashboard
2. Update your applications to use the new key
3. Once all systems are updated, revoke the old key

During the transition period, both the old and new keys will work, ensuring continuous operation.

##### Webhook Authentication

When configuring webhooks, the API key system provides a secure mechanism for authenticating callbacks:

1. Each webhook request includes a signature in the `X-Flash-Signature` header
2. The signature is an HMAC-SHA256 hash of the request payload using your API key's secret
3. Verify this signature in your webhook handler to ensure the request is authentic

See [API_KEY_IMPLEMENTATION.md](./API_KEY_IMPLEMENTATION.md) for detailed implementation information.

### Tech Stack

- GCP, Kubernetes, Terraform, Helm, Concourse, Docker
- Opentelemetry, Prometheus
- Bitcoind, LND, Specter, RideTheLightning, Loop, Lndmon, Pool
- PostgreSQL, MongoDB, Redis
- NodeJS
- Typescript
- GraphQL
- React + React Native
