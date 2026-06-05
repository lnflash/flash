/**
 * Bridge Sandbox E2E Setup
 *
 * This suite requires:
 * - RUN_BRIDGE_SANDBOX_E2E=true in environment
 * - A running backend connected to Bridge sandbox
 * - BridgeService.checkAccountLevel() allowing level >= 1
 * - IBEX_ENVIRONMENT=sandbox (safety guard)
 */

// Must mock yargs BEFORE any config imports so yaml.ts gets a valid --configPath
jest.mock("yargs", () => {
  const yargsMock = {
    option: jest.fn().mockReturnThis(),
    argv: {
      configPath: [
        "./dev/config/base-config.yaml",
      ],
    },
  }
  return jest.fn(() => yargsMock)
})

import { setupMongoConnection } from "@services/mongodb"
import { disconnectAll } from "@services/redis"
import { preflightServiceLevelGuard } from "./preflight"

let mongoose: any

beforeAll(async () => {
  // === Guard: Must be explicitly opted in ===
  if (!process.env.RUN_BRIDGE_SANDBOX_E2E) {
    throw new Error(
      "Bridge sandbox E2E skipped. Set RUN_BRIDGE_SANDBOX_E2E=true in env to run.",
    )
  }

  // === Guard: Must be pointed at sandbox, not production ===
  // Set via: export IBEX_ENVIRONMENT=sandbox  (or add to .env)
  if (process.env.IBEX_ENVIRONMENT !== "sandbox") {
    throw new Error(
      "IBEX_ENVIRONMENT must be 'sandbox' for Bridge sandbox E2E tests.\n" +
        "  Run: export IBEX_ENVIRONMENT=sandbox\n" +
        "  Or add to .env:   export IBEX_ENVIRONMENT=sandbox",
    )
  }

  // === Connect MongoDB for test user creation ===
  try {
    mongoose = await setupMongoConnection(true)
  } catch (err) {
    throw new Error(
      `MongoDB connection failed: ${err instanceof Error ? err.message : err}`,
    )
  }

  // === Preflight: Verify service-level guard allows level >= 1 ===
  const preflightOk = preflightServiceLevelGuard()
  if (!preflightOk) {
    throw new Error("Preflight failed — aborting suite.")
  }
})

afterAll(async () => {
  disconnectAll()
  if (mongoose) {
    await mongoose.connection.close()
  }
})

jest.setTimeout(Number(process.env.JEST_TIMEOUT) || 120000)
