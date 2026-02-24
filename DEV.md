# Dev Environment

## Quick Start

```bash
# 1. Clone and enter
git clone git@github.com:lnflash/flash.git && cd flash

# 2. Run the setup script (validates env, installs deps, configures credentials)
./dev/setup.sh

# 3. Start the server
make start
```

The setup script will check your prerequisites, prompt for Ibex sandbox credentials, install dependencies, and start Docker containers. After that, `make start` launches all four backend services.

**GraphQL playground:** http://localhost:4002/graphql
**Admin API:** http://localhost:4002/admin/graphql
**Test login:** phone `+16505554328`, code `000000`

---

## Manual Setup

If you prefer to set things up yourself, or if the setup script fails:

### Prerequisites

| Tool | Required Version | Install |
|------|-----------------|---------|
| Node.js | 20.x (20.18.1+ recommended) | [nvm](https://github.com/nvm-sh/nvm): `nvm install 20` |
| yarn | 1.x | `corepack enable && corepack prepare yarn@1 --activate` |
| Docker | 20+ with compose v2 | [Docker Desktop](https://www.docker.com/products/docker-desktop) |
| direnv | any (optional) | [direnv.net](https://direnv.net) |

> **Note:** The project specifies `"node": "20"` in `package.json`. Node 22+ will fail on `yarn install` due to transitive dependency engine checks. Use `--ignore-engines` if you need to override, but Node 20.x is recommended.

### 1. Environment Variables

The project loads environment variables from `.env` (committed) and `.env.local` (git-ignored, for secrets).

Create `.env.local` with your Ibex sandbox credentials:

```bash
echo "export IBEX_EMAIL='your-ibex-email'" >> .env.local
echo "export IBEX_PASSWORD='your-ibex-password'" >> .env.local
```

If you use direnv, allow it:

```bash
direnv allow
```

If not using direnv, source the env files manually before running commands:

```bash
source .env && source .env.local
```

### 2. App Config Overrides

Flash uses YAML config files. The base config is at `dev/config/base-config.yaml`. Secrets and local overrides go in `$CONFIG_PATH/dev-overrides.yaml` (default: `~/.config/flash/dev-overrides.yaml`).

**Option A — Run the interactive script:**

```bash
./dev/config/set-overrides.sh
```

**Option B — Create manually:**

```yaml
# ~/.config/flash/dev-overrides.yaml
ibex:
  email: your-ibex-email
  password: your-ibex-password
```

Additional overrides you might need:

```yaml
ibex:
  webhook:
    uri: https://your-ngrok-domain.ngrok-free.app  # for webhook testing

sendgrid:
  apiKey: SG.your-sendgrid-key  # for email notifications

cashout:
  email:
    to: your-email@example.com  # for cashout notification testing
```

### 3. Install Dependencies

```bash
yarn install
```

> If you hit engine compatibility errors, use `yarn install --ignore-engines`.

### 4. Start Docker Dependencies

```bash
make start-deps
```

This starts: MongoDB, Redis, Kratos (auth), Oathkeeper (API gateway), Apollo Router, price service, and OpenTelemetry collector.

If you need a clean slate:

```bash
make reset-deps
```

> **Note:** After restarting dependencies, reload environment variables with `direnv reload` (or re-source your `.env` files).

### 5. Start the Server

```bash
make start
```

This runs four processes in parallel:

| Process | Port | Description |
|---------|------|-------------|
| `start-main` | 4012 (direct), 4002 (via oathkeeper) | Main GraphQL API |
| `start-trigger` | — | Event trigger processor |
| `start-ws` | 4000 | WebSocket server for subscriptions |
| `start-ibex-wh` | 4008 | Ibex webhook receiver |

Access the API through the oathkeeper proxy at **http://localhost:4002/graphql** (not the direct 4012 port, which requires a JWT).

---

## Testing Ibex Webhooks

For payment event testing, you need a public URL that forwards to your local webhook server (port 4008).

```bash
# Install ngrok: https://ngrok.com
ngrok http 4008
```

Copy the forwarding URL and add it to your `dev-overrides.yaml`:

```yaml
ibex:
  webhook:
    uri: https://your-domain.ngrok-free.app
```

**Tip:** Use a [static ngrok domain](https://dashboard.ngrok.com/cloud-edge/domains) so you don't have to update the config every restart.

---

## ERPNext (Frappe)

Flash uses ERPNext for accounting. The dev config defaults to the Flash test environment at `https://erp.test.flashapp.me`.

To run Frappe locally:

```bash
make start-frappe        # start local Frappe
make reset-frappe        # clean + start + restore from backup
make stop-frappe         # stop local Frappe
```

Update your `dev-overrides.yaml` with local Frappe credentials if running locally.

---

## Testing

```bash
make test                # full suite (unit + integration)
make unit                # unit tests only (no Docker deps needed)
make integration         # integration tests (needs Docker deps)
make reset-integration   # reset state + run integration tests
```

Run a specific test file:

```bash
TEST=utils make unit              # runs utils.spec.ts
TEST=01-connection make integration  # runs 01-connection.spec.ts
```

**Known issues:**
- Integration tests are not fully idempotent — use `make reset-integration` between runs
- If tests timeout, increase: `JEST_TIMEOUT=120000 yarn test:integration`
- Use an SSD for Docker volumes (tests are disk-intensive)

---

## Architecture Overview

```
Client → Oathkeeper (4002) → GraphQL Main (4012)
                            → Admin API (4001)
         WebSocket (4000)
         Ibex Webhook (4008) ← Ibex payment events

Docker deps:
  MongoDB (27017)    — primary database
  Redis (6378→6379)  — caching, pub/sub
  Kratos (4433/4434) — identity/auth
  Price (50051)      — gRPC price service
  Apollo Router (4004) — federation
  OTEL Collector (4318) — telemetry
```

---

## Useful Commands

| Command | Description |
|---------|-------------|
| `make start` | Start all servers |
| `make start-main` | Start only the main GraphQL server |
| `make start-deps` | Start Docker dependencies |
| `make clean-deps` | Stop and remove Docker containers |
| `make reset-deps` | Clean + restart Docker deps |
| `make watch` | Start with file watching (auto-restart on changes) |
| `make check-code` | Run all linting/type checks |
| `yarn prettier -w .` | Format all files |
| `DEBUG=* make start` | Start in debug mode |

---

## Troubleshooting

### `UnauthorizedError: No authorization token was found`

You're hitting the GraphQL server directly (port 4012). Use the oathkeeper proxy at **http://localhost:4002/graphql** instead, which handles auth for anonymous/public queries.

### `The engine "node" is incompatible`

Flash requires Node 20.x. Switch with `nvm use 20` or run `yarn install --ignore-engines`.

### Docker warnings about unset variables

`IBEX_URL`, `HONEYCOMB_DATASET`, `HONEYCOMB_API_KEY` warnings in docker compose output are harmless in dev — these are only needed for the Docker-based server (not used by `make start`).

### `API key does not start with "SG."`

SendGrid isn't configured — email notifications won't work. Safe to ignore in dev unless you're testing email features. Add a real key to your `dev-overrides.yaml` if needed.

### Price service platform warning (Apple Silicon)

```
The requested image's platform (linux/amd64) does not match the detected host platform (linux/arm64/v8)
```

The `lnflash/price:edge` image is amd64-only. On Apple Silicon Macs it runs under Rosetta emulation — this is harmless but slow. The warning is safe to ignore.

### Server starts but crashes immediately

Check that all Docker deps are healthy: `docker compose ps`. If MongoDB or Redis failed to start, run `make reset-deps`.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

### Code Quality

```bash
make check-code   # ESLint + TypeScript checks
yarn prettier -w . # auto-format
```

Use editor plugins for ESLint and Prettier for best experience.
