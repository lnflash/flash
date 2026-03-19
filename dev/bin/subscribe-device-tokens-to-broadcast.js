#!/usr/bin/env node
/**
 * One-off script: subscribes all device tokens stored in deviceTopics to their
 * respective FCM topics via the Firebase Admin SDK.
 *
 * Run AFTER the migration `20260317125624-subscribe-device-tokens-to-broadcast` has
 * been applied to populate the deviceTopics field.
 *
 * Required env vars:
 *   MONGODB_CON                     e.g. mongodb://localhost/galoy
 *   GOOGLE_APPLICATION_CREDENTIALS  path to Firebase service account JSON
 *   FCM_TOPIC_PREFIX                (optional) e.g. "test" → topic becomes "test-broadcast"
 *                                   omit on prod → topic is "broadcast"
 */

const { MongoClient } = require("mongodb")
const admin = require("firebase-admin")

const BATCH_SIZE = 1000

const MONGODB_CON = process.env.MONGODB_CON
if (!MONGODB_CON) {
  console.error("Error: MONGODB_CON environment variable is required")
  process.exit(1)
}

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("Error: GOOGLE_APPLICATION_CREDENTIALS environment variable is required")
  process.exit(1)
}

admin.initializeApp({ credential: admin.credential.applicationDefault() })
const messaging = admin.messaging()

async function subscribeInBatches(tokens, topic) {
  let successCount = 0
  let failureCount = 0

  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    const batch = tokens.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1
    console.log(
      `Subscribing batch ${batchNum} (tokens ${i + 1}–${i + batch.length}) to topic "${topic}"`,
    )

    const response = await messaging.subscribeToTopic(batch, topic)
    successCount += response.successCount
    failureCount += response.failureCount

    if (response.errors.length > 0) {
      response.errors.forEach(({ index, error }) => {
        console.warn(`  Token[${index}] failed: ${error.message}`)
      })
    }
  }

  return { successCount, failureCount }
}

async function main() {
  const client = new MongoClient(MONGODB_CON)

  try {
    await client.connect()
    const db = client.db()

    const users = await db
      .collection("users")
      .find(
        { deviceTopics: { $exists: true } },
        { projection: { _id: 0, deviceTopics: 1 } },
      )
      .toArray()

    if (users.length === 0) {
      console.log("No users with deviceTopics found — run the migration first")
      return
    }

    // Group tokens by topic
    const tokensByTopic = {}
    for (const user of users) {
      for (const [token, topics] of Object.entries(user.deviceTopics)) {
        for (const topic of topics) {
          if (!tokensByTopic[topic]) tokensByTopic[topic] = []
          tokensByTopic[topic].push(token)
        }
      }
    }

    for (const [topic, tokens] of Object.entries(tokensByTopic)) {
      console.log(`\nSubscribing ${tokens.length} tokens to topic "${topic}"`)
      const { successCount, failureCount } = await subscribeInBatches(tokens, topic)
      console.log(`Done — success: ${successCount}, failures: ${failureCount}`)
    }
  } finally {
    await client.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
