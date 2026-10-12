import {
  startPaymentSplitsLoop,
  stopPaymentSplitsLoopOnShutdown,
} from "@app/payment-splits/split-loop"
import WebookServer from "@services/ibex/webhook-server"
import { setupMongoConnection } from "@services/mongodb"
import { warnIfDevContext } from "@utils/dev-context"

import { exitOnBootFailure } from "./boot"

if (require.main === module) {
  // This process serves the public, unauthenticated GET /pay/lnurl/:username,
  // whose SSRF guard is the thing a dev context turns off. Say so at boot.
  warnIfDevContext()

  setupMongoConnection()
    .then(async () => {
      WebookServer.start()
      // ENG-653: split reconcile, executor and stale sweep run here, every
      // paymentSplits.loopIntervalMs; the daily galoy cron is too slow. On
      // SIGTERM (rollout, kube-monkey) the split send in flight finishes and
      // no new one starts, so a deploy does not strand a row in `sending`.
      const splitsLoop = startPaymentSplitsLoop()
      if (splitsLoop) stopPaymentSplitsLoopOnShutdown(splitsLoop)
    })
    .catch(exitOnBootFailure)
}
