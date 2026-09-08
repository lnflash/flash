import { baseLogger } from "@services/logger"

// A boot failure must take the process down — whichever server hit it, and
// whether it failed synchronously or after an await.
//
// The previous shape was `Promise.race([startCore(), startAdmin()])` with a
// single `.catch(process.exit)` on the race, which only crashed when the
// FAILING start happened to settle first. The admin server binds its own port
// (GALOY_ADMIN_PORT): if that port is taken, `httpServer.on("error")` rejects
// after the core server has already resolved and won the race. A race's result
// is final, so that rejection fell through to the process-level
// `unhandledRejection` handler, which only logs — leaving exactly the state
// the crash-loudly comment claimed to prevent: a pod reporting healthy while
// the admin API is dead. It happened to work for the weak-secret guard only
// because `assertStrongSecret` throws synchronously and therefore always won.
//
// Attaching the fatal handler to EACH start makes the guarantee independent of
// ordering and of whether a guard is sync or async.
export const exitOnBootFailure = (err: unknown): never => {
  baseLogger.error(err, "server error")
  return process.exit(1)
}

// Starts every server, killing the process on the first failure. Resolves as
// soon as the first server is listening (each start resolves on `listen`), so
// callers can bring up follow-on listeners without waiting on the slowest one.
export const startServersOrExit = async (
  starts: ReadonlyArray<() => Promise<unknown>>,
): Promise<unknown> =>
  // `Promise.resolve().then(start)` rather than `start()` so a start that
  // throws synchronously is caught by the same handler.
  Promise.race(
    starts.map((start) => Promise.resolve().then(start).catch(exitOnBootFailure)),
  )
