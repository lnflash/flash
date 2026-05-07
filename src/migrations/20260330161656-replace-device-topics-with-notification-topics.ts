/* eslint @typescript-eslint/ban-ts-comment: "off" */
// @ts-nocheck
/* eslint @typescript-eslint/no-var-requires: "off" */

const topicsEnv = process.env.NOTIFICATION_TOPICS
if (!topicsEnv) throw new Error("NOTIFICATION_TOPICS env var is required (comma-separated list of FCM topic names)")
const topics = topicsEnv.split(",").map(t => t.trim()).filter(Boolean)

module.exports = {
  async up(db) {
    console.log("Begin migration: replace deviceTopics with notificationTopics")

    // Remove deviceTopics from all users
    await db
      .collection("users")
      .updateMany({ deviceTopics: { $exists: true } }, { $unset: { deviceTopics: 1 } })

    // Add notificationTopics to all users
    const result = await db
      .collection("users")
      .updateMany({}, { $set: { notificationTopics: topics } })

    console.log(`Migration complete: deviceTopics removed, notificationTopics set for ${result.modifiedCount} users`)
  },

  async down(db) {
    console.log("Begin rollback: remove notificationTopics from all users")

    const result = await db
      .collection("users")
      .updateMany({ notificationTopics: { $exists: true } }, { $unset: { notificationTopics: 1 } })

    console.log(`Rollback complete: notificationTopics removed from ${result.modifiedCount} users`)
  },
}
