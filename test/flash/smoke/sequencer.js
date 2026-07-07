const Sequencer = require("@jest/test-sequencer").default

// Run specs in filename order (00-, 01-, ...): later phases depend on state
// created by earlier ones (accounts, funding), mirroring the UAT phase plan.
class SmokeSequencer extends Sequencer {
  sort(tests) {
    return [...tests].sort((a, b) => a.path.localeCompare(b.path))
  }
}

module.exports = SmokeSequencer
