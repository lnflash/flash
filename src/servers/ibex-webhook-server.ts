import WebookServer from "@services/ibex/webhook-server"
import { baseLogger } from "@services/logger"
import { setupMongoConnection } from "@services/mongodb"
import { warnIfDevContext } from "@utils/dev-context"

if (require.main === module) {
  // This process serves the public, unauthenticated GET /pay/lnurl/:username,
  // whose SSRF guard is the thing a dev context turns off. Say so at boot.
  warnIfDevContext()

  setupMongoConnection()
    .then(async () => WebookServer.start())
    .catch((err) => baseLogger.error(err, "ibex webhook server error"))
}
