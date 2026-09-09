jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { exitOnBootFailure, startServersOrExit } from "@servers/boot"
import { baseLogger } from "@services/logger"

const logError = baseLogger.error as unknown as jest.Mock

// Nothing after `process.exit(1)` runs in production; the stub returns instead,
// so the assertions are on the call, not on what follows it.
const stubProcessExit = () =>
  jest.spyOn(process, "exit").mockImplementation((() => undefined) as never)

// A start that never settles — the second server in a race, so the assertions
// are unambiguously about the first.
const never = () =>
  new Promise<never>(() => {
    // deliberately never settles
  })

const flush = () => new Promise((resolve) => setTimeout(resolve, 5))

describe("startServersOrExit", () => {
  let exitSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    exitSpy = stubProcessExit()
  })

  afterEach(() => {
    exitSpy.mockRestore()
  })

  it("resolves once the first server is listening, and kills nothing", async () => {
    const listening = jest.fn().mockResolvedValue("core listening")

    await expect(startServersOrExit([listening, never])).resolves.toBe("core listening")
    expect(exitSpy).not.toHaveBeenCalled()
    expect(logError).not.toHaveBeenCalled()
  })

  // The regression this file exists for. The old shape was
  // `Promise.race([startCore(), startAdmin()])` with one `.catch(exit)` on the
  // race: when the admin server failed AFTER the core server had already
  // resolved — a taken GALOY_ADMIN_PORT rejects from httpServer.on("error"),
  // long after core is listening — the race's result was already final and the
  // admin rejection only reached the process-level unhandledRejection logger.
  // The pod then reported healthy with a dead admin API: precisely the state
  // the "crash loudly" comment claimed to prevent.
  it("exits when a server fails AFTER another has already resolved", async () => {
    const core = jest.fn().mockResolvedValue("core listening")
    const adminFailure = new Error("listen EADDRINUSE: address already in use :::4001")
    const admin = jest.fn(
      async () =>
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(adminFailure), 0)
        }),
    )

    await expect(startServersOrExit([core, admin])).resolves.toBe("core listening")
    await flush()

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(logError).toHaveBeenCalledWith(adminFailure, "server error")
  })

  // The weak-secret boot guard is synchronous today (assertStrongSecret is the
  // first statement of startAdminServer), which is the only reason the old race
  // was fatal for it: a synchronous throw always settles first. Put one await
  // in front of that guard — fetching the secret from a secret manager, say —
  // and the old shape degraded to a log line. Both shapes must be fatal here.
  it.each([
    [
      "a synchronous throw",
      () => {
        throw new Error("WeakSecretError: ERPNEXT_JWT_SECRET")
      },
    ],
    [
      "an async rejection",
      async () => {
        await Promise.resolve()
        throw new Error("WeakSecretError: ERPNEXT_JWT_SECRET")
      },
    ],
  ])("exits on %s from any start", async (_label, failing) => {
    await startServersOrExit([failing as () => Promise<unknown>, never])
    await flush()

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("ERPNEXT_JWT_SECRET") }),
      "server error",
    )
  })

  it("reports every failing server, not just the one that won the race", async () => {
    const boom = async () => {
      throw new Error("boom")
    }

    await startServersOrExit([boom, boom])
    await flush()

    expect(logError).toHaveBeenCalledTimes(2)
    expect(exitSpy).toHaveBeenCalledTimes(2)
  })
})

describe("exitOnBootFailure", () => {
  let exitSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    exitSpy = stubProcessExit()
  })

  afterEach(() => {
    exitSpy.mockRestore()
  })

  it("logs the error and exits non-zero", () => {
    const err = new Error("mongo unreachable")

    exitOnBootFailure(err)

    expect(logError).toHaveBeenCalledWith(err, "server error")
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
