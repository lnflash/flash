# Gift cards

Flash users buy third-party gift cards (Amazon, Visa prepaid, etc.) from inside
the app and pay for them in sats from their Flash wallet. Flash resells cards
from an external vendor; the first vendor is The Bitcoin Company (TBC).

**Architecture in one sentence:** the vendor's catalog is mirrored into Redis
by a cron job, a purchase creates a Mongo order row and then a vendor order,
Flash pays the vendor's Lightning invoice from the user's IBEX-custodial wallet
through the same idempotent send path every other payment uses, and a
reconcile worker polls the vendor until the card's claim data arrives and is
stored encrypted on the order.

- Linear: project **ENG-574** (this doc set is ENG-588).
- Design document: *Gift Cards — Architecture Design*. The code is
  authoritative where the two disagree; each file below notes where it does.

## Documents

| File | What it covers |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layers and files, the provider port, the order state machine, payment rail, idempotency, claim encryption, Redis keys, Mongo indexes, jobs |
| [FLOWS.md](FLOWS.md) | Sequence diagrams: happy path, vendor reject, quote mismatch, pending payment, refund required, expiry, idempotent replay |
| [API.md](API.md) | The public GraphQL contract and every `GIFT_CARD_*` error code |
| [CONFIG.md](CONFIG.md) | Every `giftCards.*` key, per-environment guidance, routing, limits modes |
| [ALERTING.md](ALERTING.md) | Every `giftcard` ops event, what pages vs warns, span attributes |
| [RUNBOOK.md](RUNBOOK.md) | Operator procedures: refunds, stuck orders, kill switches, credential and key rotation, enforce flip, stale catalog, adding a provider |
| [TESTING.md](TESTING.md) | Unit suites, the Mongo integration spec, the planned sandbox e2e, what is not covered |

## Where the code lives

| Layer | Path |
| --- | --- |
| Domain (types, errors, state machine) | `src/domain/gift-cards/` |
| Provider registry, catalog cache, claim crypto | `src/services/gift-cards/` |
| TBC adapter | `src/services/gift-cards/bitcoin-company/` |
| Use cases (purchase, settle, reconcile, sync, reads) | `src/app/gift-cards/` |
| Payment rail | `src/app/payments/pay-invoice-via-ibex.ts` |
| Persistence | `src/services/mongoose/gift-card-orders.ts`, `src/migrations/20260909120000-gift-card-orders-indexes.ts` |
| GraphQL | `src/graphql/public/root/query/gift-card-*.ts`, `src/graphql/public/root/mutation/gift-card-purchase.ts` |
| Config | `src/config/schema.ts` (`giftCards`), `dev/config/base-config.yaml` |
| Jobs | `src/servers/cron.ts`, `src/servers/trigger.ts` |

The feature ships **off** (`giftCards.enabled: false`, every provider disabled,
limits in `log-only`). See [CONFIG.md](CONFIG.md) for what to turn on where.
