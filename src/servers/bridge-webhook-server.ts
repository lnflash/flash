import { startBridgeWebhookServer } from "@services/bridge/webhook-server"
import { setupMongoConnection } from "@services/mongodb"
import { warnIfDevContext } from "@utils/dev-context"

import { exitOnBootFailure } from "./boot"

if (require.main === module) {
  warnIfDevContext()

  setupMongoConnection()
    .then(async () => startBridgeWebhookServer())
    .catch(exitOnBootFailure)
}
