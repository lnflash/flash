import { startBridgeWebhookServer } from "@services/bridge/webhook-server"
import { baseLogger } from "@services/logger"
import { setupMongoConnection } from "@services/mongodb"
import { warnIfDevContext } from "@utils/dev-context"

if (require.main === module) {
  warnIfDevContext()

  setupMongoConnection()
    .then(async () => startBridgeWebhookServer())
    .catch((err) => baseLogger.error(err, "bridge webhook server error"))
}
