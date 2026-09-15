# Flash 

[![Twitter Follow](https://img.shields.io/twitter/follow/LNFlash?style=social)](https://twitter.com/LNFlash)
[![GitHub Repo stars](https://img.shields.io/github/stars/lnflash/flash?style=social)](https://github.com/lnflash/flash/stargazers)
### 💡 Get help
Open an [issue](https://github.com/lnflash/flash/issues) or email [support@getflash.io](mailto:support@getflash.io). Developer docs for the public API are at [docs.flashapp.me](https://docs.flashapp.me).

### TLDR

Flash is an opinionated Bitcoin banking platform for the Caribbean. It started as a fork of [Galoy](https://github.com/GaloyMoney/blink) (now Blink) and has since diverged; upstream Galoy channels are not Flash support channels.

This repo represents the main api that brings all functionality together.
Take a look at the [Quickstart](./quickstart) if you want to take it for a spin.

### Responsible disclosure 

Found critical bugs/vulnerabilities?
Please email security@getflash.io. See [SECURITY.md](./SECURITY.md).

### Get Started

Want to try it out and contribute? Checkout the [dev documentation](./DEV.md) to deploy locally with a docker compose script.

If you have questions, open an [issue](https://github.com/lnflash/flash/issues).

The other Flash repositories (mobile app, POS, docs, deployments) live in the [lnflash](https://github.com/lnflash) organization.
### Backend features

Inherited from Galoy unless noted. Items marked "in progress" describe the upstream design at fork time and are not Flash roadmap.

- GraphqlAPI:
  - Public API following industry best practices
  - For [end clients](./src/graphql/public/schema.graphql). [Documentation](https://docs.flashapp.me)
  - For [admin activities](./src/graphql/admin/schema.graphql)
- Authentication:
  - Code is sent via Twilio (SMS or WhatsApp) to the end user's phone number and exchanged for an opaque session token
  - Account-scoped API keys (shipped): `apiKeyCreate`, `apiKeys`, `apiKeyRotate`, `apiKeyRevoke`, sent as `X-API-KEY`. See the [API keys guide](https://docs.flashapp.me/guides/api-keys)
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
  - DDos prevention 
    - via rate limiting infront of critical APIs
    - via geetest CAPTCHA
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

### Tech Stack

- GCP, Kubernetes, Terraform, Helm, Concourse, Docker
- Opentelemetry, Prometheus
- Bitcoind, LND, Specter, RideTheLightning, Loop, Lndmon, Pool
- PostgreSQL, MongoDB, Redis
- NodeJS
- Typescript
- GraphQL
- React + React Native
