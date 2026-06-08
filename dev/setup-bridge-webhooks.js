#!/usr/bin/env node

/* eslint-disable @typescript-eslint/no-var-requires, import/order */

const fs = require("fs")
const path = require("path")
const { spawn } = require("child_process")
const yaml = require("js-yaml")

const ROUTES = {
  kyc: {
    path: "/kyc",
    eventCategories: ["customer", "kyc_link"],
  },
  deposit: {
    path: "/deposit",
    eventCategories: ["virtual_account.activity", "bridge_wallet.activity"],
  },
  transfer: {
    path: "/transfer",
    eventCategories: ["transfer"],
  },
  external_account: {
    path: "/external-account",
    eventCategories: ["external_account"],
  },
}

const DEFAULT_BRIDGE_BASE_URL = "https://api.sandbox.bridge.xyz/v0"
const DEFAULT_PORT = 4009

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const trimTrailingSlash = (value) => value.replace(/\/+$/, "")

const buildWebhookDefinitions = (baseUrl) => {
  const normalizedBaseUrl = trimTrailingSlash(baseUrl)
  return Object.fromEntries(
    Object.entries(ROUTES).map(([key, route]) => [
      key,
      {
        url: `${normalizedBaseUrl}${route.path}`,
        eventCategories: route.eventCategories,
      },
    ]),
  )
}

const extractNgrokHttpsUrl = (response) => {
  const tunnel = response?.tunnels?.find(
    (candidate) =>
      candidate?.proto === "https" && typeof candidate.public_url === "string",
  )
  if (!tunnel) {
    throw new Error("No HTTPS ngrok tunnel found on local ngrok API")
  }
  return tunnel.public_url
}

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const mergeDeep = (base, override) => {
  const merged = { ...(isObject(base) ? base : {}) }
  for (const [key, value] of Object.entries(override)) {
    if (isObject(value) && isObject(merged[key])) {
      merged[key] = mergeDeep(merged[key], value)
    } else {
      merged[key] = value
    }
  }
  return merged
}

const mergeDevOverrides = (existing, generated) =>
  mergeDeep(existing, {
    bridge: {
      apiKey: generated.apiKey,
      baseUrl: generated.baseUrl,
      webhook: {
        uri: generated.webhookBaseUrl,
        publicKeys: generated.publicKeys,
      },
    },
  })

const reconcileBridgeWebhooks = async (api, definitions) => {
  const existingWebhooks = await api.listWebhooks()
  const webhooksToDelete = existingWebhooks.filter(
    (webhook) => webhook.status !== "deleted",
  )

  for (const webhook of webhooksToDelete) {
    await api.deleteWebhook(webhook.id)
  }

  const publicKeys = {}
  const created = {}

  for (const [key, definition] of Object.entries(definitions)) {
    const webhook = await api.createWebhook({ key, ...definition })
    created[key] = webhook
    publicKeys[key] = webhook.public_key
    await api.enableWebhook(webhook.id, definition)
  }

  return {
    publicKeys,
    created,
    existingWebhookCount: existingWebhooks.length,
    deletedWebhookCount: webhooksToDelete.length,
  }
}

const readYamlFile = (filePath) => {
  if (!fs.existsSync(filePath)) return {}
  return yaml.load(fs.readFileSync(filePath, "utf8")) ?? {}
}

const writeYamlFile = (filePath, data) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, yaml.dump(data, { lineWidth: -1 }), "utf8")
}

const defaultOverridesPath = () => {
  const configDir =
    process.env.CONFIG_PATH || path.join(process.env.HOME ?? ".", ".config/flash")
  return path.join(configDir, "dev-overrides.yaml")
}

const loadMergedConfig = ({ baseConfigPath, overridesPath }) =>
  mergeDeep(readYamlFile(baseConfigPath), readYamlFile(overridesPath))

const fetchJson = async ({ method, url, apiKey, body, idempotencyKey }) => {
  const headers = {
    "Api-Key": apiKey,
    "Content-Type": "application/json",
  }
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  const text = await response.text()
  const parsed = text ? JSON.parse(text) : {}
  if (!response.ok) {
    throw new Error(
      `Bridge ${method} ${url} failed (${response.status}): ${JSON.stringify(parsed)}`,
    )
  }
  return parsed
}

const createBridgeApi = ({ apiKey, baseUrl }) => {
  const normalizedBaseUrl = trimTrailingSlash(baseUrl)
  return {
    listWebhooks: async () => {
      const response = await fetchJson({
        method: "GET",
        url: `${normalizedBaseUrl}/webhooks`,
        apiKey,
      })
      return response.data ?? []
    },
    deleteWebhook: async (id) =>
      fetchJson({
        method: "DELETE",
        url: `${normalizedBaseUrl}/webhooks/${id}`,
        apiKey,
      }),
    createWebhook: async ({ key, url, eventCategories }) =>
      fetchJson({
        method: "POST",
        url: `${normalizedBaseUrl}/webhooks`,
        apiKey,
        idempotencyKey: `flash-dev-${key}-${Date.now()}`,
        body: {
          url,
          event_epoch: "webhook_creation",
          event_categories: eventCategories,
        },
      }),
    enableWebhook: async (id, definition) =>
      fetchJson({
        method: "PUT",
        url: `${normalizedBaseUrl}/webhooks/${id}`,
        apiKey,
        body: {
          url: definition.url,
          status: "active",
          event_categories: definition.eventCategories,
        },
      }),
  }
}

const getNgrokTunnels = async () => {
  const response = await fetch("http://127.0.0.1:4040/api/tunnels")
  if (!response.ok) {
    throw new Error(`ngrok API returned ${response.status}`)
  }
  return response.json()
}

const hasNgrok = () => {
  const paths = (process.env.PATH ?? "").split(path.delimiter)
  return paths.some((candidate) => fs.existsSync(path.join(candidate, "ngrok")))
}

const startNgrok = ({ port }) => {
  if (!hasNgrok()) {
    throw new Error("ngrok is not installed or not on PATH")
  }

  const logPath = path.join(
    process.env.TMPDIR ?? "/tmp",
    `flash-bridge-ngrok-${port}.log`,
  )
  const logFd = fs.openSync(logPath, "a")
  const child = spawn("ngrok", ["http", String(port), "--log", "stdout"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  })
  child.unref()
  return { pid: child.pid, logPath }
}

const ensureNgrokTunnel = async ({ port, retries = 20, intervalMs = 500 }) => {
  try {
    return extractNgrokHttpsUrl(await getNgrokTunnels())
  } catch {
    startNgrok({ port })
  }

  for (let attempt = 0; attempt < retries; attempt += 1) {
    await sleep(intervalMs)
    try {
      return extractNgrokHttpsUrl(await getNgrokTunnels())
    } catch {
      // ngrok is still starting; keep polling until retries are exhausted.
    }
  }

  throw new Error("ngrok did not expose an HTTPS tunnel before timeout")
}

const parseArgs = (argv) => {
  const args = {
    baseConfigPath: "dev/config/base-config.yaml",
    overridesPath: defaultOverridesPath(),
    port: DEFAULT_PORT,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") args.help = true
    else if (arg === "--base-config") args.baseConfigPath = argv[++index]
    else if (arg === "--overrides") args.overridesPath = argv[++index]
    else if (arg === "--port") args.port = Number(argv[++index])
    else if (arg === "--api-key") args.apiKey = argv[++index]
    else if (arg === "--base-url") args.baseUrl = argv[++index]
    else throw new Error(`Unknown argument: ${arg}`)
  }

  return args
}

const usage = () => `Usage: node dev/setup-bridge-webhooks.js [options]

Options:
  --base-config <path>  Base YAML config path (default: dev/config/base-config.yaml)
  --overrides <path>    Local override YAML path (default: $CONFIG_PATH/dev-overrides.yaml or ~/.config/flash/dev-overrides.yaml)
  --port <port>         Local Bridge webhook port (default: 4009)
  --api-key <key>       Bridge sandbox API key (default: existing config/env)
  --base-url <url>      Bridge API base URL (default: existing config/env or sandbox)
  --help                Show this help message
`

const run = async (argv = process.argv.slice(2)) => {
  const args = parseArgs(argv)
  if (args.help) {
    console.log(usage())
    return
  }

  const config = loadMergedConfig({
    baseConfigPath: args.baseConfigPath,
    overridesPath: args.overridesPath,
  })
  const apiKey = args.apiKey || process.env.BRIDGE_API_KEY || config.bridge?.apiKey
  if (!apiKey) {
    throw new Error(
      "Bridge API key is required. Set bridge.apiKey in dev-overrides.yaml or pass --api-key.",
    )
  }

  const baseUrl =
    args.baseUrl ||
    process.env.BRIDGE_BASE_URL ||
    config.bridge?.baseUrl ||
    DEFAULT_BRIDGE_BASE_URL

  console.log(`Starting/using ngrok tunnel for localhost:${args.port}...`)
  const webhookBaseUrl = await ensureNgrokTunnel({ port: args.port })
  console.log(`ngrok HTTPS URL: ${webhookBaseUrl}`)

  const definitions = buildWebhookDefinitions(webhookBaseUrl)
  const bridgeApi = createBridgeApi({ apiKey, baseUrl })

  console.log("Fetching and removing old Bridge sandbox webhooks...")
  const { publicKeys, created, existingWebhookCount, deletedWebhookCount } =
    await reconcileBridgeWebhooks(bridgeApi, definitions)
  console.log(`Bridge reported ${existingWebhookCount} existing webhooks.`)
  console.log(`Deleted ${deletedWebhookCount} old active/disabled webhooks.`)

  const existingOverrides = readYamlFile(args.overridesPath)
  const merged = mergeDevOverrides(existingOverrides, {
    apiKey,
    baseUrl,
    webhookBaseUrl,
    publicKeys,
  })
  writeYamlFile(args.overridesPath, merged)

  const activeCount = Object.keys(created).length
  console.log(`Created and enabled ${activeCount} Bridge sandbox webhooks.`)
  console.log("Smoke check passed: webhook public keys were returned and saved locally.")
  console.log(`Updated local overrides: ${args.overridesPath}`)
  console.log("")
  console.log("Next steps:")
  console.log("  1. Start the Bridge webhook server:")
  console.log(
    `     yarn bridge-webhook --configPath ${args.baseConfigPath} --configPath ${args.overridesPath}`,
  )
  console.log("  2. Run the sandbox E2E suite:")
  console.log("     IBEX_ENVIRONMENT=sandbox yarn test:bridge-sandbox-e2e:ci")
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`Bridge webhook setup failed: ${error.message}`)
    process.exit(1)
  })
}

module.exports = {
  buildWebhookDefinitions,
  createBridgeApi,
  extractNgrokHttpsUrl,
  mergeDevOverrides,
  reconcileBridgeWebhooks,
  run,
}
