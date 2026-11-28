# POS USDT Live Activity updates (iOS, APNs sandbox preview)

The server side of the iOS Live Activity for a public POS USDT checkout. The
private workstation observer (`qa/watch-apple.py` + `qa/apple-relay.cjs`) works
by reading a token off a USB-paired phone. This replaces it with a deployable
path: the app opts a device in over GraphQL, and a worker sends the pushes.

It is **off by default**, only talks to the **APNs sandbox**, and production
APNs is not implemented. Turning production on needs a reviewed code change,
not a configuration change.

## What it does

- **One new public field**, `posUsdtLiveUpdateConsent`. Like
  `posUsdtCheckoutStatus`, it is authorised by one receipt: the caller proves it
  holds the receipt id and the sale key. It is receive-only and rate limited per
  IP and per receipt. It is separate from `posUsdtCheckoutCreate`.
- **Progress comes only from the checkout**: `followedStatus`, the same verified,
  throttled read-back the POS's own status poll runs. A device can never give a
  milestone: the input has no stage, status or amount.
- **Pushes, at most four per device**, each at least 2 s after the previous one,
  with strictly increasing APNs timestamps:

  | rank | checkout status | pose   | APNs event |
  |------|-----------------|--------|------------|
  | 0    | DETECTED        | folded | `update`   |
  | 1    | DETECTED        | lifted | `update`   |
  | 2    | PAID            | folded | `update`   |
  | 3    | PAID            | lifted | `end` (terminal, dismissed after 300 s) |

  The worker sends only the poses for the stage the checkout is in now, so a sale
  first seen PAID gets ranks 2 and 3 only. Once APNs accepts a rank, it is never
  sent again and never goes backwards. Only an accepted rank 3 ends a device.
- **Failure isolation**: the opt-in and the worker have their own collection,
  rate limits and process. Nothing here writes a checkout row or a credit. A
  failure in the store, vault, APNs or worker can delay a lock-screen update.
  It can never change a payment.

## Native contract (iOS app)

### Opting in

Send this only after the user has agreed to lock-screen payment updates. Call
it from JS, which already holds the receipt; the receipt id still never reaches
native code. Native exports only the activity id and its push token.

```graphql
mutation posUsdtLiveUpdateConsent($input: PosUsdtLiveUpdateConsentInput!) {
  posUsdtLiveUpdateConsent(input: $input) { accepted errors { message } }
}
```

| field           | value |
|-----------------|-------|
| `action`        | `ENROLL` or `WITHDRAW` |
| `receiptId`     | the checkout `id` from `posUsdtCheckoutCreate`, as sent to `posUsdtCheckoutStatus` (64 lowercase hex) |
| `saleKey`       | `usdtFlightKey(receiptId, scope)` from `src/services/paymentFlight.ts`: `SHA-256("flash.pos.usdt-flight.v1\n" + scope + "\n" + receiptId)` as lowercase hex. `scope` is the exact endpoint string the app hashes (`previewChainEndpoint(...) ?? FLASH_GRAPHQL_URI`). |
| `activityId`    | ActivityKit `Activity.id` (a UUID string) |
| `tokenSequence` | an integer from 1 to 2147483647. It must increase with every request for this activity: each rotation and each withdrawal. Persist it per activity. |
| `pushToken`     | `ENROLL` only: the `pushTokenUpdates` value as lowercase hex (16–512 bytes). Leave it out for `WITHDRAW`. |

- Send `ENROLL` for each value `pushTokenUpdates` yields, with the next
  sequence. A rotation replaces the old token, and pushes in flight to the old
  token are re-sent to the new one.
- Send `WITHDRAW` when the user turns updates off, when `stopUsdtFlight` runs,
  or when the activity reaches `.dismissed` or `.ended`.
- Only the newest sequence wins. An older request that arrives late is accepted
  but changes nothing. An exact repeat is accepted too. The same sequence with a
  different token is refused.
- At most 2 devices per receipt follow at once, and at most 4 activities are
  ever recorded for a receipt. A device can't opt in once the checkout is PAID.
  It also can't opt in after the follow window closes (60 minutes by default,
  counted from the first opt-in).

When `accepted` is `true`, stop. When it is `false`, act on `errors[0].message`:

| message | action |
|---------|--------|
| `Unknown checkout.` · `Invalid live update request.` · `…maximum number of devices.` · `…already paid.` · `…have ended…` · `…conflicts…` · `Live updates are unavailable.` | do not retry |
| `Too many live update requests…` · `…temporarily unavailable.` · `…busy…` | retry with backoff (≥ 5 s, increasing) |

### What the activity receives

The headers are `apns-push-type: liveactivity`, `apns-topic:
<bundle>.push-type.liveactivity`, `apns-priority: 10` and `apns-expiration: now +
180`. The payload is exactly the one the private relay sends:

```json
{"aps":{"timestamp":1800000000,"event":"update",
        "content-state":{"stage":0,"cents":0,"folded":true,"singleStroke":false}}}
```

`event` is `"end"` only for `stage: 1, folded: false`, which also adds
`"dismissal-date": timestamp + 300`. `ContentState` is unchanged from the
current widget. No receipt, amount, wallet, address or account is ever sent.
ActivityKit drops a push whose timestamp is not newer, and the server never
reuses or lowers one for a device.

## Operator configuration

Set these on the API and the worker. If any value is missing or invalid, the
feature stays off: the API answers `Live updates are unavailable.` and the
worker exits 0 with a log line that names the variable but not its value.

| variable | value |
|----------|-------|
| `POS_USDT_CHECKOUT_ENABLED` | `true` (the checkout itself, see `flash.ts`) |
| `POS_USDT_LIVE_UPDATES_ENABLED` | `true` |
| `POS_USDT_LIVE_APNS_ENVIRONMENT` | `sandbox`. This is the only accepted value; `production` keeps the feature off. |
| `POS_USDT_LIVE_SCOPES` | 1–3 comma-separated endpoints, exactly as the app hashes them, in canonical URL form (`new URL(s).toString() === s`). For example: `https://api.test.flashapp.me/graphql` |
| `POS_USDT_LIVE_TOKEN_KEYS` *or* `POS_USDT_LIVE_TOKEN_KEYS_FILE` | keyring `kid:base64(32 random bytes)[,kid:…]`. The first key seals and every listed key opens. The file form must not be readable by "other" (for example, a secret volume with `defaultMode: 0440` and `fsGroup`). |
| `POS_USDT_LIVE_FOLLOW_MINUTES` | optional, 1–480, default 60 |

Worker only:

| variable | value |
|----------|-------|
| `POS_USDT_LIVE_APNS_TEAM_ID` | 10-character Apple team id |
| `POS_USDT_LIVE_APNS_KEY_ID` | 10-character key id of the token-signing key |
| `POS_USDT_LIVE_APNS_KEY_FILE` | path to the `.p8` (P-256). It must not be readable by "other". Keep it in the secret store; never in the image or the repo. |
| `POS_USDT_LIVE_APNS_TOPIC` | `<bundle id>.push-type.liveactivity`, for example `com.flash.pos.preview.push-type.liveactivity` |

**Worker.** Run `node lib/servers/pos-usdt-live-worker.js` with the same config
as the API. Run one or more replicas: receipts are leased, so a push is sent by
one worker only. No chart is included. Scale it to 0 to stop pushes; enrolment
keeps working and the backlog expires on its own.

**Rate limits** (`src/domain/rate-limit/index.ts`):
- `pos_usdt_live_consent_ip`: 30 requests per minute per IP.
- `pos_usdt_live_consent_receipt`: 12 requests per 10 minutes per receipt, keyed
  by the checkout digest, never the receipt id.

**Storage.** Collection `posusdtliveupdates`, one document per receipt, keyed by
the checkout key (`sha256(receiptId)`). Tokens are stored only sealed with
AES-256-GCM. The AAD binds each token to its receipt and activity, so a sealed
token cannot be moved to another document. A token is wiped as soon as its
device is done, revoked, failed or withdrawn, and every token is wiped when the
follow window ends. A TTL index deletes each document 24 h after its window
ends. Until then it keeps only digests and counters, so a replayed request
cannot restart a receipt that has ended.

**Key rotation.** Put the new key first and keep the old key listed for at least
the follow window plus 24 h. Then remove it.

**Logs.** Events are `live_status_unreadable`, `live_token_unreadable`,
`live_push_not_accepted` (with the APNs reason word, e.g. `BadDeviceToken`) and
`live_follow_error`. They carry a 12-character prefix of the checkout digest and
the slot digest. They never contain a receipt id, sale key, push token, sealed
token, provider JWT, key or key path.

**Retries.** Transient failures retry with exponential backoff, from 1 s up to
60 s, or longer if APNs sends `retry-after`. After 8 attempts the device is
dropped. `410` / `BadDeviceToken` / `DeviceTokenNotForTopic` revoke the token
until the app sends a new one. A provider-token refusal (403) is retried, and
`ExpiredProviderToken` forces a fresh JWT.

## Not included

- Production APNs: no host, no flag.
- A Helm chart or deployment for the worker.
- Waking the worker from the IBEX Hub webhook. It polls each followed receipt
  every 3 s instead, so the hub route stays unchanged.
- Android: it uses its own user-started foreground service.
