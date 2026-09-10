# Gift Cards Configuration

The `giftCards` block is defined in `src/config/schema.ts` (types in
`src/config/schema.types.d.ts`), defaulted in `dev/config/base-config.yaml`,
and read through `GiftCardsConfig` (`src/config/yaml.ts`). Like the rest of
`yamlConfig` it is read **once at process start** from `--configPath`; a change
needs the api, trigger and cron pods replaced (same discipline as
`docs/send-guard.md`, "Rolling back").

Local overrides go in `$CONFIG_PATH/dev-overrides.yaml`
(`dev/config/set-overrides.sh`), never in `base-config.yaml`.

## Keys

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Master switch. Off: `giftCardCatalog`, `giftCardQuote` and `giftCardPurchase` return `GIFT_CARDS_DISABLED`, `globals.giftCardsEnabled` is false, both jobs are no-ops. `giftCardOrder` / `giftCardOrders` still resolve (owner-scoped reads of paid orders) |
| `allowOpenLoop` | boolean | `false` | Show and sell open-loop (Visa/Mastercard-style) cards. Off: hidden from the catalog, `GIFT_CARD_PRODUCT_NOT_FOUND` by id, `GIFT_CARDS_DISABLED` on purchase. On: still requires account level >= 2 |
| `feeBps` | integer | `0` | Flash markup on face value, basis points. **Not read by any code path today** (reserved) |
| `claimDataEncryptionKey` | string | `""` | 32-byte AES-256-GCM key: 64 hex chars, or base64 of exactly 32 bytes. Empty key: fulfilment leaves orders `PAID` and pages (`claim-encrypt-failed`); reads throw `GIFT_CARD_CLAIM_UNAVAILABLE` |
| `quoteToleranceBps` | integer | `100` | Max the vendor invoice may exceed the quote (1% default) before the purchase is refused with `GIFT_CARD_QUOTE_MISMATCH`. Overrides the domain constant `GIFT_CARD_QUOTE_TOLERANCE_BPS` |
| `routing.default` | `bitcoinCompany` \| `bitrefill` | `bitcoinCompany` | Provider for any country not listed in `byCountry`, including unknown (`"XX"`) |
| `routing.byCountry` | map CC -> provider id | `{}` | ISO 3166-1 alpha-2 (upper case; lookups are normalised) -> provider id |
| `providers.bitcoinCompany.enabled` | boolean | `false` | Provider switch. A country routed to a disabled provider gets `GIFT_CARD_PROVIDER_UNAVAILABLE` |
| `providers.bitcoinCompany.baseUrl` | string | `https://api.dev.thebitcoincompany.com` | Sandbox (Mutinynet). Production is `https://api.thebitcoincompany.com` |
| `providers.bitcoinCompany.email` / `password` | string | `""` | Login credentials for `POST /auth/login`. Empty: every authenticated call fails with `GIFT_CARD_VENDOR_UNAVAILABLE` (`BitcoinCompanyAuthError`) |
| `providers.bitcoinCompany.referralCode` | string | `""` | **Not read by the client today** |
| `providers.bitcoinCompany.timeoutMs` | integer | `10000` | Per-request axios timeout |
| `providers.bitrefill.*` | | disabled, empty | Schema only. **No Bitrefill adapter exists**; routing to it is always unavailable |
| `catalog.syncIntervalSeconds` | integer | `21600` (6 h) | Minimum gap between catalog pulls, enforced by the `giftcards:catalog-sync:last-run` marker |
| `catalog.ttlSeconds` | integer | `21600` (6 h) | Age past which a catalog is served `stale: true` and a `catalog-stale` ops event posts |
| `catalog.staleAfterSeconds` | integer | `86400` (24 h) | Redis TTL on every catalog key. Past this the catalog is gone and reads throw `GIFT_CARD_CATALOG_UNAVAILABLE`. Must be > `ttlSeconds` and > `syncIntervalSeconds` |
| `limits.mode` | `off` \| `log-only` \| `enforce` | `log-only` | See "Limits modes" |
| `limits.minAccountLevel` | integer | `1` | Level floor. Level 0 is refused regardless |
| `limits.minAccountAgeHours` | integer | `24` | New-account cooldown |
| `limits.maxOrdersPerHour` | integer | `5` | Velocity: orders created in the trailing hour, any status |
| `limits.vendorDailyCapCents` | integer | `1000000` ($10,000) | TBC per-user daily cap (FinCEN prepaid-access exemption). Applied on top of the level cap |
| `limits.vendorOpenLoopCardCapCents` | integer | `100000` ($1,000) | TBC per-order cap for open-loop cards |
| `limits.vendorClosedLoopCardCapCents` | integer | `200000` ($2,000) | TBC per-order cap for closed-loop cards |
| `limits.perLevel.level{0..3}.perCardCents` | integer | 0 / 20000 / 50000 / 100000 | Flash per-order cap by account level (value x quantity) |
| `limits.perLevel.level{0..3}.dailyCents` | integer | 0 / 50000 / 200000 / 500000 | Flash trailing-24h cap by level, summed over non-failed orders plus live holds |

A level the config does not name (a future level 4) inherits `level3`
(`levelLimits` in `src/app/gift-cards/authorize-purchase.ts`).

Every sub-object is `additionalProperties: false`; a typo in an override fails
config validation at boot rather than being ignored.

## Environment variables

| Var | Used for |
| --- | --- |
| `OPS_DISCORD_WEBHOOK_URL` | The `giftcard` ops-event feed (`src/config/env.ts`). Unset: events are dropped silently |
| `MONGODB_CON`, `REDIS_*` | Orders and the catalog/locks/holds, same as the rest of the service |

There is no gift-card-specific env var; everything else is YAML.

## Per-environment guidance

**Never commit real credentials or a real claim key.** `base-config.yaml` ships
`email`, `password`, `referralCode` and `claimDataEncryptionKey` empty on
purpose; put real values in the deployment's values file / secret overrides
and in `$CONFIG_PATH/dev-overrides.yaml` locally.

| | Sandbox / staging | Production |
| --- | --- | --- |
| `providers.bitcoinCompany.baseUrl` | `https://api.dev.thebitcoincompany.com` (Mutinynet; pays with test sats) | `https://api.thebitcoincompany.com` |
| Credentials | TBC sandbox account | TBC production reseller account |
| `claimDataEncryptionKey` | Any 32-byte key; may differ from prod | Generated once, stored as a secret, backed up: losing it makes every stored claim unreadable |
| `limits.mode` | `log-only` or `enforce` | `log-only` until the would-reject review (RUNBOOK f), then `enforce` |
| `enabled` / `providers.*.enabled` | `true` when testing | Flip together; see RUNBOOK (d) |

Generating a key:

```sh
openssl rand -hex 32          # 64 hex chars
# or
openssl rand -base64 32       # 44 chars, decodes to 32 bytes
```

Both formats are accepted; surrounding whitespace from an override is
tolerated. The key id stored on orders is derived from the raw bytes, so the
same key in either encoding yields the same `claimKeyId`.

## How routing works

`resolveGiftCardProviderIdForCountry(cc)` (`src/services/gift-cards/registry.ts`):

1. Normalise `cc` (trim, upper case).
2. `routing.byCountry[cc]`, else `routing.default`.
3. The result must be enabled (`enabled && providers.<id>.enabled`) **and**
   registered by an adapter; otherwise `GiftCardProviderUnavailableError`.

The account's country is its phone country when that is unambiguous
(`resolveAccountCountryCode`); otherwise the sentinel `"XX"`, which is
user-assigned in ISO 3166 and can never appear in `byCountry`, so unknown
countries always take `routing.default`. `giftCardCatalog(countryCode:)` lets
the client browse another country, but the purchase always routes by the
account's country.

Because only `bitcoinCompany` is registered, the only useful `byCountry`
entries today are none; the map exists so a second provider is config, not
code (`{ JM: bitrefill }` once that adapter lands).

## Limits modes

`limits.mode` mirrors `sendGuard.mode` (`docs/send-guard.md`):

| Mode | Checks run | On failure | `reservationId` |
| --- | --- | --- | --- |
| `off` | none | n/a | `null` (nothing held) |
| `log-only` | all | `giftcard / would-reject` ops event (status pending) + span attributes, then **allowed** | set, or `null` if the hold write failed (logged, allowed) |
| `enforce` | all | `giftcard / rejected` ops event (status failed), purchase refused with the check's error | set; a hold write failure refuses with `GIFT_CARD_UNKNOWN` |

Checks, in order (`evaluate` in `authorize-purchase.ts`): level, account age,
open-loop switch and level >= 2, per-card cap = `min(perLevel, vendor card cap)`,
velocity, daily cap = `min(perLevel.dailyCents, vendorDailyCapCents)` over
non-failed orders in the trailing 24 h plus live Redis holds. `REFUND_REQUIRED`
orders count toward the daily sum (money left); `FAILED`, `PAYMENT_FAILED`,
`EXPIRED` do not. A Mongo or Redis fault is `limits-unavailable`: allowed in
`log-only`, refused (`GIFT_CARD_UNKNOWN`, level Critical) in `enforce`.

Independent of mode: the 10/min purchase attempt limiter and the ENG-573 send
guard on the payment itself always run.
