import express, { Request, Response } from "express"
import { authenticate, logRequest } from "../middleware"
import { WalletsRepository } from "@services/mongoose/wallets"
import { ZapRequestModel } from "@services/mongoose/zap-request"
import axios from "axios"
import { baseLogger as logger } from "@services/logger"
import { AccountsRepository } from "@services/mongoose"
import { bech32 } from "bech32"

const paths = {
  invoice: "/pay/invoice",
  lnurl: "/pay/lnurl/:username",
  onchain: "/pay/onchain",
}

export function decodeLnurl(lnurl: string): { callback: string } {
  try {
    const decoded = bech32.decode(lnurl, 1500)
    const bytes = bech32.fromWords(decoded.words)
    const url = Buffer.from(bytes).toString()
    return { callback: url }
  } catch (err) {
    throw new Error("Failed to decode lnurl: " + err)
  }
}

// async function listAccounts() {
//   const repo = AccountsRepository()
//   const result = await repo.listUnlockedAccounts()

//   if (result instanceof Error) {
//     console.error("Error fetching accounts:", result)
//     return
//   }
//   for await (const acct of result) {
//     // Print the entire object as JSON
//     console.log(JSON.stringify(acct, null, 2))
//   }
// }

const router = express.Router()

router.get(paths.lnurl, logRequest, async (req: Request, resp: Response) => {
  console.log("i'm inside")
  try {
    const { username } = req.params
    const { amount, nostr, comment } = req.query
    console.log("NOSTR IN REquest body", nostr)
    if (!username) return resp.status(400).json({ error: "username is required" })
    if (!amount) return resp.status(400).json({ error: "amount is required" })

    let requestEvent: any | null = null
    if (nostr) {
      try {
        requestEvent = JSON.parse(decodeURIComponent(nostr as string))
      } catch (err) {
        logger.warn({ err, nostr }, "Failed to decode nostr in proxy callback")
        requestEvent = null
      }
    }

    // 1. Lookup wallet for the user
    const account = await AccountsRepository().findByUsername(username as Username)
    if (account instanceof Error) {
      return resp.status(404).json({ error: "User not found" })
    }
    const wallet = await WalletsRepository().listByAccountId(account.id)
    if (!wallet || wallet instanceof Error || wallet.length === 0) {
      return resp.status(404).json({ error: "No wallet found for this user" })
    }
    const lnurlp = wallet[0].lnurlp
    if (!lnurlp)
      return resp.status(404).json({ error: "No lnurlp found for this wallet" })

    // 2. Decode lnurlp to get invoice callback URL
    const decoded = decodeLnurl(lnurlp)
    const callbackUrl = decoded.callback
    if (!callbackUrl)
      return resp.status(500).json({ error: "Failed to decode lnurl callback URL" })
    const lnurlResponse = await axios.get(callbackUrl)
    const invoiceAddress = lnurlResponse.data.callback
    // 3. Call original invoice callback URL to generate invoice
    const invoiceResp = await axios.get(invoiceAddress, {
      params: {
        amount,
        comment: comment || "Zap payment",
      },
    })
    const { pr: bolt11, successAction } = invoiceResp.data
    if (!bolt11) return resp.status(500).json({ error: "Failed to generate invoice" })

    // Extract payment hash from bolt11 (or use library if needed)
    const invoiceHash = extractPaymentHashFromBolt11(bolt11)
    if (!invoiceHash)
      return resp.status(500).json({ error: "Failed to extract payment hash" })

    // 4. Save zap request in Mongo
    if (requestEvent) {
      const zapRecord = new ZapRequestModel({
        bolt11,
        invoiceHash,
        accountUsername: username,
        nostrJson: JSON.stringify(requestEvent),
        amountMsat: amount,
        createdAt: new Date(),
        fulfilled: false,
      })
      const document = await zapRecord.save()
      console.log("Document stgored", document)
    }

    // 5. Return LNURL-pay JSON
    return resp.json({
      pr: bolt11,
      successAction: successAction || null,
      routes: [],
    })
  } catch (err) {
    logger.error({ err }, "LNURL-pay proxy callback failed")
    return resp.status(500).json({ error: "Internal server error" })
  }
})

// Keep other routes as stubs
router.post(paths.invoice, authenticate, logRequest, async (_: Request, resp: Response) =>
  resp.status(200).end(),
)
router.post(paths.onchain, authenticate, logRequest, async (_: Request, resp: Response) =>
  resp.status(200).end(),
)

export { paths, router }

/**
 * Helper: extract payment hash from bolt11
 * You can use a proper BOLT11 decoding library if available
 */
function extractPaymentHashFromBolt11(bolt11: string): string | null {
  try {
    console.log("BOLT 11 ISL", bolt11)
    const decoded = require("bolt11").decode(bolt11)
    console.log("BOLT 11 ISL decoded", decoded)
    const hashTag = decoded.tags.find((t: any) => t.tagName === "payment_hash")
    return hashTag?.data || null
  } catch {
    return null
  }
}
