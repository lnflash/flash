// Pin one run id for the whole run so every spec file derives the same
// usernames (each jest spec file gets its own module registry).
module.exports = async () => {
  if (!process.env.SMOKE_RUN_ID) {
    process.env.SMOKE_RUN_ID = Math.random().toString(36).slice(2, 8)
  }
}
