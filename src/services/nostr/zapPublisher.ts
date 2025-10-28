// services/nostr/zap-publisher.ts
import { baseLogger as logger } from "@services/logger"
import { Event, finalizeEvent, getPublicKey, nip19 } from "nostr-tools"
import { pool } from "../../utils/nostr"
import WebSocket from "ws"

// @ts-ignore
globalThis.WebSocket = WebSocket

export interface PublishFromWebhookArgs {
  zapRequest: Event // deserialized nostrJson
  amountMsat: number
  bolt11: string
  recipientUser: any
  recipientAccount: any
  receiverWallet: any
}

export const ZapPublisher = {
  publishFromWebhook: async ({
    zapRequest,
    amountMsat,
    bolt11,
    recipientUser,
    recipientAccount,
    receiverWallet,
  }: PublishFromWebhookArgs) => {
    console.log("Zap publisher called")
    try {
      if (!process.env.NOSTR_PRIVATE_KEY) {
        throw new Error("NOSTR_PRIVATE_KEY is not set")
      }
      const secretKey = nip19.decode(process.env.NOSTR_PRIVATE_KEY).data as Uint8Array
      const serverPubkey = getPublicKey(secretKey)
      // 1. Build the 9735 zap receipt event
      const zapReceipt = {
        kind: 9735,
        pubkey: serverPubkey, // the sender pubkey from the original zap request
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["bolt11", bolt11],
          ["p", zapRequest.pubkey], // the original zap request sender pubkey
          ["amount", amountMsat.toString()],
        ],
        content: "", // optional message / comment
      }

      const signedEvent = finalizeEvent(zapReceipt, secretKey)
      const relaysTag = zapRequest.tags.find((tag) => tag[0] === "relays")
      const relays = relaysTag ? relaysTag.slice(1) : []
      console.log("Publishing Zap receipts TO", relays)
      pool.publish(relays, signedEvent)

      logger.info(
        { zapReceipt },
        `Published zap receipt for invoice ${bolt11.substring(0, 10)}...`,
      )
    } catch (err) {
      logger.error({ err }, "Failed to publish zap receipt")
    }
  },
}
