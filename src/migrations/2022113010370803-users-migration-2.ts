module.exports = {
  async up(db) {
    console.log("Begin account to users property migration")
    const res = db
      .collection("accounts")
      .updateMany(
        {},
        { $unset: { phone: 1, twilio: 1, language: 1, deviceToken: 1 } },
        { multi: true },
      )
    console.log({ res }, `removing deprecated fields`)
  },
}
