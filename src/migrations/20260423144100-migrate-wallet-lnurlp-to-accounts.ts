/* eslint @typescript-eslint/ban-ts-comment: "off" */
// @ts-nocheck

module.exports = {
  async up(db) {
    console.log("Begin migration to migrate wallet lnurlp to account lnurlps array")
    const walletsCursor = db.collection("wallets").find({ lnurlp: { $type: "string", $ne: "" } })

    let migratedCount = 0
    while (await walletsCursor.hasNext()) {
      const wallet = await walletsCursor.next()
      const { _accountId, id: walletId, lnurlp } = wallet

      if (_accountId && lnurlp) {
        await db.collection("accounts").updateOne(
          { _id: _accountId },
          {
            $addToSet: {
              lnurlps: {
                lnurlp,
                active: true,
                walletId,
              },
            },
          },
        )
        migratedCount++
      }
    }

    console.log(`Migrated ${migratedCount} wallet lnurlps to accounts`)
  },

  async down(db) {
    console.log("Begin rollback of wallet lnurlp migration")
    await db.collection("accounts").updateMany({}, { $set: { lnurlps: [] } })
    console.log("Rollback completed")
  },
}
