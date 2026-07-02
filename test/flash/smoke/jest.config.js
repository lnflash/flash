const swcConfig = require("../../../swc-config.json")

// UAT smoke suite: black-box tests against a RUNNING Flash GraphQL endpoint.
// No app imports, no database access — everything goes through the public API,
// so the same suite runs against the local quickstart stack, CI, or TEST.
// See ./README.md for the UAT-matrix coverage map and required env vars.
module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: "../../../",
  roots: ["<rootDir>/test/flash/smoke/specs"],
  transform: {
    "^.+\\.(t|j)s$": ["@swc/jest", swcConfig],
  },
  testRegex: ".*\\.spec\\.ts$",
  testEnvironment: "node",
  globalSetup: "<rootDir>/test/flash/smoke/globalSetup.js",
  testSequencer: "<rootDir>/test/flash/smoke/sequencer.js",
  testTimeout: 60000,
}
