# Bridge Alerting (ENG-361)

Operational alerting for the Bridge integration. When a Bridge signal fails
(webhook processing, ERPNext audit write, or a Bridge API outage), the
`AlertService` (`src/services/alerts`) fans the alert out to the configured
destinations.

## Routing

| Severity     | PagerDuty (page) | Slack / Mattermost (inform) | Discord (inform) |
| ------------ | :--------------: | :-------------------------: | :--------------: |
| **critical** |        ✅        |             ✅              |        ✅        |
| **warning**  |        —         |             ✅              |        ✅        |

Delivery is best-effort and fire-and-forget — a failing or unconfigured
destination never blocks or fails the webhook/request path. **A destination
with no configured credential is silently skipped**, so channels can be enabled
incrementally.

### Deduplication

Alerts carry a stable `dedupKey` so repeated failures do not spam on-call or chat:

| Destination | Behavior |
| ----------- | -------- |
| **PagerDuty** | Events API v2 `dedup_key` groups triggers into one incident |
| **Slack / Discord** | First message per `dedupKey` within TTL; duplicates are skipped |

Key classes (see `src/services/alerts/dedup-key.ts`):

- `bridge-api:5xx` / `bridge-api:timeout` / `bridge-api:network` — coarse outage keys (30 min inform TTL)
- `erpnext-audit:deposit:{transfer_id}` — per deposit audit failure (1 h inform TTL)
- `erpnext-audit:transfer-complete:{transfer_id}` / `transfer-failed:{transfer_id}` — per transfer audit failure
- `bridge-webhook:deposit:{event_id}` / `bridge-webhook:transfer:{transfer_id}:{event}` — per webhook processing error
- `ibex:crypto-receive:{tx_hash}` — per IBEX crypto receive webhook failure (1 h inform TTL)
- `ibex:reconcile:bridge-without-ibex:{tx_hash}` / `ibex:reconcile:ibex-without-bridge:{tx_hash}` — per reconciliation orphan
- `ibex:reconcile:failed:{tx_hash}` — reconciliation handler threw

Inform dedup is in-process per pod; PagerDuty dedup is global to the service integration.

## Alert sources

| Source                                            | Severity | Where                                                       |
| ------------------------------------------------- | -------- | ----------------------------------------------------------- |
| ERPNext audit-write failure (deposit + transfer)  | critical | `services/bridge/webhook-server/routes/{deposit,transfer}.ts` |
| Bridge webhook processing exception               | critical | same routes (catch block)                                   |
| Bridge API outage — 5xx / timeout / network       | critical | `services/bridge/client.ts`                                 |
| IBEX crypto receive webhook failure               | warning  | `services/ibex/webhook-server/routes/crypto-receive.ts`     |
| Bridge↔IBEX reconciliation orphan / failure         | warning  | `services/bridge/reconciliation.ts`, deposit/crypto catch |

`4xx` responses from Bridge are normal API rejections and are **not** alerted.

## Configuration

Three optional env vars, each gating one destination:

| Env var                       | Destination         | Value                                       |
| ----------------------------- | ------------------- | ------------------------------------------- |
| `ALERT_PAGERDUTY_ROUTING_KEY` | PagerDuty           | Events API v2 **integration / routing key** |
| `ALERT_SLACK_WEBHOOK_URL`     | Slack or Mattermost | Incoming-webhook URL                        |
| `ALERT_DISCORD_WEBHOOK_URL`   | Discord             | Channel webhook URL                         |

### How to get each value

**PagerDuty** — `ALERT_PAGERDUTY_ROUTING_KEY`
1. PagerDuty → **Services** → pick (or create) the service that should page for Bridge.
2. **Integrations** → **Add integration** → **Events API v2**.
3. Copy the **Integration Key** — that is the routing key.

**Slack** — `ALERT_SLACK_WEBHOOK_URL`
1. Create/choose a Slack app → **Incoming Webhooks** → **Activate**.
2. **Add New Webhook to Workspace** → choose the target channel.
3. Copy the URL (`https://hooks.slack.com/services/...`).
   _Mattermost works too_ — it accepts the same `{ text }` payload; use its incoming-webhook URL.

**Discord** — `ALERT_DISCORD_WEBHOOK_URL`
1. Discord → target channel → **Edit Channel** → **Integrations** → **Webhooks**.
2. **New Webhook** → name it → **Copy Webhook URL**.

### Where to set them

- **Local dev:** add to `.env` (and `.env.ci` for CI).
- **Staging / production:** set as environment variables / secrets in the deployment — the same place `MATTERMOST_WEBHOOK_URL` is configured. Treat all three as **secrets**.

> If none are set, alerting is a no-op (no errors, no delivery) — useful until the channels are provisioned.

## Verifying in staging (ENG-361 acceptance)

1. Set at least `ALERT_PAGERDUTY_ROUTING_KEY` and `ALERT_SLACK_WEBHOOK_URL` in staging.
2. Simulate a Bridge webhook failure (e.g. force an ERPNext audit-write error, or replay a malformed transfer webhook).
3. Confirm on-call is paged via PagerDuty **and** a message posts to Slack within ~1 minute.
