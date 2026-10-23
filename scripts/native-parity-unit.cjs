// Run with Node 24. No .env, shell evaluation, inherited service credentials,
// arbitrary Jest arguments, integration suites, or forced process termination.
const { spawn } = require("node:child_process")
const path = require("node:path")

const root = path.resolve(__dirname, "..")
const unit = "test/flash/unit/"
const suites = Object.freeze({
  bridge: [
    "app/bridge/get-withdrawal-flash-fee-notice.spec.ts",
    "app/bridge/kyc-gate.spec.ts",
    "app/bridge/send-deposit-notification.spec.ts",
    "app/bridge/send-kyc-notification.spec.ts",
    "app/bridge/send-withdrawal-notification.spec.ts",
    "dev/setup-bridge-webhooks.spec.ts",
    "graphql/bridge-error-map.spec.ts",
    "graphql/public/root/mutation/bridge-add-external-account.spec.ts",
    "graphql/public/root/mutation/bridge-external-account.spec.ts",
    "graphql/public/root/mutation/bridge-initiate-kyc.spec.ts",
    "graphql/public/root/mutation/bridge-withdrawal.spec.ts",
    "graphql/public/root/query/bridge-withdrawals.spec.ts",
    "graphql/public/types/object/bridge-contract.spec.ts",
    "services/alerts/ibex-bridge-movement.spec.ts",
    "services/bridge/client-owned-kyc-links.spec.ts",
    "services/bridge/client.spec.ts",
    "services/bridge/ethereum-gas-estimate.spec.ts",
    "services/bridge/exchange-plaid-public-token.spec.ts",
    "services/bridge/index.spec.ts",
    "services/bridge/initiate-kyc-owned-links.spec.ts",
    "services/bridge/plaid-available-for-ip.spec.ts",
    "services/bridge/reconciliation.spec.ts",
    "services/bridge/return-shapes.spec.ts",
    "services/bridge/webhook-server/deposit.spec.ts",
    "services/bridge/webhook-server/enabled-guard.spec.ts",
    "services/bridge/webhook-server/kyc.spec.ts",
    "services/bridge/webhook-server/ops-events-webhooks.spec.ts",
    "services/bridge/webhook-server/replay.spec.ts",
    "services/bridge/webhook-server/transfer.spec.ts",
    "services/bridge/webhook-server/verify-signature.spec.ts",
    "services/bridge/withdrawal-fees.spec.ts",
    "services/mongoose/accounts-bind-bridge-customer.spec.ts",
    "services/notification/wa-bridge.spec.ts",
  ],
  earn: ["app/payments/add-earn.spec.ts", "services/mongoose/rewards.spec.ts"],
  storage: [
    "services/storage/id-document-presigned-put.spec.ts",
    "services/storage/id-documents.spec.ts",
  ],
  telemetry: [
    "app/admin/send-user-notification.spec.ts",
    "app/api-keys/create-api-key.spec.ts",
    "app/authentication/registration-trace-privacy.spec.ts",
    "app/authentication/telemetry-privacy.spec.ts",
    "app/authentication/validate-preregistration-payload.spec.ts",
    "app/invite/send-referral-notifications.spec.ts",
    "servers/request-log.spec.ts",
    "services/frappe/ErpNext.bankAccountUpdate.spec.ts",
    "services/frappe/ErpNext.bankAccounts.spec.ts",
    "services/frappe/ErpNext.idVerification.spec.ts",
    "services/frappe/ErpNext.spec.ts",
    "services/frappe/request-telemetry-privacy.spec.ts",
    "services/fygaro/webhook-server/payment.spec.ts",
    "services/http-trace-privacy.spec.ts",
    "services/ibex/request-trace-privacy.spec.ts",
    "services/notifications/firebase-telemetry-privacy.spec.ts",
    "services/notifications/push-notifications.spec.ts",
    "services/notification/telemetry-privacy.spec.ts",
    "services/tracing-input-privacy.spec.ts",
    "services/tracing.spec.ts",
  ],
  device: [
    "app/accounts/device-account-bootstrap.spec.ts",
    "app/accounts/device-bootstrap-adapters.spec.ts",
    "app/authentication/login-device-bootstrap.spec.ts",
    "app/authentication/login-device-upgrade.spec.ts",
    "app/authentication/totp-enrollment-policy.spec.ts",
    "app/cash-wallet-cutover/device-bootstrap-presentation.spec.ts",
    "graphql/public/root/mutation/totp-registration-initiate-policy.spec.ts",
    "graphql/totp-enrollment-error-map.spec.ts",
    "servers/authorization/device-bootstrap-route.spec.ts",
    "services/kratos/device-bootstrap-identity.spec.ts",
    "services/mongoose/device-bootstrap.spec.ts",
  ],
  ownership: [
    "app/accounts/owned-wallet-snapshot-adapters.spec.ts",
    "app/accounts/owned-wallet-snapshot.spec.ts",
    "graphql/ln-invoice-payment-send.spec.ts",
    "graphql/ln-send-marker-withdrawal.spec.ts",
    "graphql/owned-wallet-snapshot.spec.ts",
  ],
})

function safeEnvironment(inherited) {
  return {
    ...(inherited.PATH ? { PATH: inherited.PATH } : {}),
    ...(inherited.TMPDIR ? { TMPDIR: inherited.TMPDIR } : {}),
    NODE_ENV: "test",
    LOGLEVEL: "fatal",
    NETWORK: "regtest",
    HELMREVISION: "native-parity-unit",
    KRATOS_PG_CON: "postgres://unit:unit@127.0.0.1:9/unit",
    OATHKEEPER_DECISION_ENDPOINT: "http://127.0.0.1:9",
    KRATOS_PUBLIC_API: "http://127.0.0.1:9",
    KRATOS_ADMIN_API: "http://127.0.0.1:9",
    TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
    TWILIO_AUTH_TOKEN: "unit-fixture-not-a-live-credential",
    TWILIO_VERIFY_SERVICE_ID: "VA00000000000000000000000000000000",
    KRATOS_MASTER_USER_PASSWORD: "unit-fixture-master-password-never-for-deployment",
    KRATOS_CALLBACK_API_KEY: "unit-fixture-callback-key-never-for-deployment",
    BRIA_HOST: "127.0.0.1",
    BRIA_PORT: "9",
    BRIA_API_KEY: "unit-fixture-bria-key-never-for-deployment",
    MONGODB_CON:
      "mongodb://127.0.0.1:9/unit?directConnection=true&serverSelectionTimeoutMS=500",
    REDIS_TYPE: "standalone",
    REDIS_MASTER_NAME: "unit",
    REDIS_PASSWORD: "unit-fixture",
    REDIS_0_DNS: "127.0.0.1",
    REDIS_0_PORT: "9",
    PRICE_HOST: "127.0.0.1",
    PRICE_HISTORY_HOST: "127.0.0.1",
    PRICE_SERVER_HOST: "127.0.0.1",
    PRICE_PORT: "9",
    PRICE_HISTORY_PORT: "9",
  }
}

function selection(args) {
  if (args.some((group) => !Object.hasOwn(suites, group))) {
    throw new Error("Select only bridge, earn, storage, telemetry, device, ownership; no other Jest arguments allowed")
  }
  return [...new Set(args.length ? args : Object.keys(suites))].flatMap((group) =>
    suites[group].map((file) => unit + file),
  )
}

function main(args) {
  if (process.versions.node.split(".")[0] !== "24") {
    throw new Error("Native parity unit fixtures require Node 24 (see package engines)")
  }
  const paths = selection(args)
  console.log(
    `Running ${paths.length} isolated unit suites with dummy-only configuration`,
  )
  const child = spawn(
    process.execPath,
    [
      "--require",
      path.join(root, "test/flash/unit/native-parity-network.cjs"),
      path.join(root, "node_modules/jest/bin/jest.js"),
      "--config",
      "test/flash/unit/jest.config.js",
      "--runInBand",
      "--watchman=false",
      "--runTestsByPath",
      ...paths,
    ],
    { cwd: root, env: safeEnvironment(process.env), stdio: "inherit", shell: false },
  )
  child.on("error", () => {
    console.error("Unable to start the local Node/Jest unit runner")
    process.exitCode = 1
  })
  child.on("exit", (code, signal) => {
    if (signal) console.error(`Unit runner terminated by ${signal}`)
    process.exitCode = code ?? 1
  })
}

module.exports = { safeEnvironment, selection, suites }
if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
