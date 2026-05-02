import { startBridgeWebhookServer } from "@services/bridge/webhook-server"
import { baseLogger } from "@services/logger"
import { setupMongoConnection } from "@services/mongodb"

if (require.main === module) {
  setupMongoConnection()
    .then(async () => startBridgeWebhookServer())
    .catch((err) => baseLogger.error(err, "bridge webhook server error"))
}
