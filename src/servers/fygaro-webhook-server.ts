import { startFygaroWebhookServer } from "@services/fygaro/webhook-server"
import { baseLogger } from "@services/logger"
import { setupMongoConnection } from "@services/mongodb"

if (require.main === module) {
  setupMongoConnection()
    .then(async () => startFygaroWebhookServer())
    .catch((err) => baseLogger.error(err, "fygaro webhook server error"))
}
