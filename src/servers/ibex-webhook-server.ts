import WebookServer from "@services/ibex/webhook-server"
import { setupMongoConnection } from "@services/mongodb"
import { warnIfDevContext } from "@utils/dev-context"

import { exitOnBootFailure } from "./boot"

if (require.main === module) {
  // This process serves the public, unauthenticated GET /pay/lnurl/:username,
  // whose SSRF guard is the thing a dev context turns off. Say so at boot.
  warnIfDevContext()

  setupMongoConnection()
    .then(async () => WebookServer.start())
    .catch(exitOnBootFailure)
}
