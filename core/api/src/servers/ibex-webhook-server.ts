import WebookServer from "@/services/ibex/webhook-server";
import { baseLogger } from "@/services/logger";
import { setupMongoConnection } from "@/services/mongodb";

if (require.main === module) {
  setupMongoConnection()
    .then(async () => WebookServer.start())
    .catch((err) => baseLogger.error(err, "ibex webhook server error"));
}
