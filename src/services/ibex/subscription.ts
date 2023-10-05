import express, { Request, Response } from "express"
import { baseLogger as log } from "@services/logger"
import { NotificationsService } from "@services/notifications"
import { IbexEventError } from "./errors"

export const startServer = () => {
    const app = express()
    const port = 8889

    // Middleware to parse JSON requests
    app.use(express.json());

    app.get("/ibex", sayHi)
    app.post("/invoice/status", publishInvoiceStatus)
    app.listen(port, () => log.info(`Listening for ibex events on port ${port}!`))
}

const sayHi = (req, resp) => {
    log.info("Ibex Server: Hello")
    resp.send("Ibex server is running")
}

const publishInvoiceStatus = async (req: Request, resp: Response) => {
    log.info("Call from Ibex: publishInvoiceStatus")
    const { webhookSecret, transaction, status } = req.body

    if (webhookSecret !== "secret") return resp.status(401).end("Invalid secret")

    const nsResp = await NotificationsService().ibexTxReceived({paymentHash: transaction.payment.hash})
    if (nsResp instanceof NotificationsService) {
      log.error(nsResp)
      return resp.status(500).end()
    }

    log.info("Ibex: IbexTxReceived notification published")
    return resp.end()
}

// export const subscribeToAll = async (
//   eventHandler: (event: any) => void,
// ): Promise<Stream<IbexEvent> | IbexEventError> => {
//   try {
//     const lastSequence = await BriaEventRepo().getLatestSequence()
//     if (lastSequence instanceof Error) {
//       return lastSequence
//     }

//     const request = new SubscribeAllRequest()
//     request.setAugment(true)
//     request.setAfterSequence(lastSequence)

//     const onDataHandler = wrapAsyncToRunInSpan({
//       root: true,
//       namespace: "service.bria",
//       fnName: "subscribeToAllHandler",
//       fn: eventDataHandler(eventHandler),
//     })

//     return streamBuilder<RawBriaEvent, SubscribeAllRequest>(subscribeAll)
//       .withOptions({ retry: true, acceptDataOnReconnect: false })
//       .withRequest(request)
//       .withMetadata(metadata)
//       .onData(onDataHandler)
//       .onError(async (stream, error) => {
//         baseLogger.info({ error }, "Error subscribeToAll stream")
//         const sequence = await BriaEventRepo().getLatestSequence()
//         if (sequence instanceof Error) {
//           // worst case it will reprocess some events
//           baseLogger.error({ error: sequence }, "Error getting last sequence")
//           return
//         }
//         stream.request.setAfterSequence(sequence)
//       })
//       .onRetry((_, { detail }) =>
//         baseLogger.info({ ...detail }, "Retry subscribeToAll stream"),
//       )
//       .withBackoff(new FibonacciBackoff(30000, 7))
//       .build()
//   } catch (error) {
//     return new UnknownBriaEventError(error)
//   }
// }



// sample body:
/*
{
  "webhookSecret": string,
  "transaction": {
    "id": string,
    "createdAt": string,
    "accountId": string,
    "amount": int,
    "networkFee": int,
    "exchangeRateCurrencySats": int,
    "currencyID": int,
    "transactionTypeId": int,
    "payment": {
      "bolt11": string,
      "hash": string,
      "preImage": string,
      "memo": string,
      "amountMsat": int,
      "feeMsat": int,
      "paidMsat": int,
      "creationDateUtc": string,
      "settleDateUtc": string,
      "statusId": int,
      "failureId": int,
      "failureReason": {
        "id": int,
        "name": string,
        "description": string
      },
      "status": {
        "id": int,
        "name": string,
        "description": string
      }
    }
  }
}
*/

// export const subscription = {
    
// }
