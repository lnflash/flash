/* eslint @typescript-eslint/ban-ts-comment: "off" */
// @ts-nocheck
/* eslint @typescript-eslint/no-var-requires: "off" */

// Topics vary be environment, must be passed in to match yaml config
const topicsEnv = process.env.NOTIFICATION_TOPICS
if (!topicsEnv) throw new Error("NOTIFICATION_TOPICS env var is required (comma-separated list of FCM topic names)")
const topics = topicsEnv.split(",").map(t => t.trim()).filter(Boolean)

module.exports = {
  async up(db) {
    console.log(`Begin migration: write deviceTopics field for topics "${topics.join(", ")}" to all users with device tokens`)

    const users = await db
      .collection("users")
      .find(
        { deviceTokens: { $exists: true, $not: { $size: 0 } } },
        { projection: { _id: 1, deviceTokens: 1 } },
      )
      .toArray()

    if (users.length === 0) {
      console.log("No users with device tokens found — nothing to do")
      return
    }

    console.log(`Found ${users.length} users with device tokens`)

    const bulkOps = users.map((user) => {
      const deviceTopics = {}
      for (const token of user.deviceTokens ?? []) {
        deviceTopics[token] = topics
      }
      return {
        updateOne: {
          filter: { _id: user._id },
          update: { $set: { deviceTopics } },
        },
      }
    })

    await db.collection("users").bulkWrite(bulkOps)

    console.log(`Migration complete: ${bulkOps.length} users updated with deviceTopics`)
  },

  async down(db) {
    console.log("Begin rollback: remove deviceTopics field from all users")

    await db
      .collection("users")
      .updateMany({ deviceTopics: { $exists: true } }, { $unset: { deviceTopics: 1 } })

    console.log("Rollback complete: deviceTopics removed from all users")
  },
}
