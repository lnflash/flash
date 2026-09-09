import fs from "fs"
import path from "path"

// A boot chain that ends in `.catch((err) => baseLogger.error(err, "..."))`
// logs and then leaves a live process that never bound its port: the
// healthy-pod-with-a-dead-listener shape @servers/boot was written to kill.
// The entrypoint body sits behind `require.main === module`, so it cannot be
// driven from a unit test — this asserts the shape of the source instead,
// which is exactly the regression (two entrypoints kept a log-only catch
// through the PR that introduced exitOnBootFailure).
//
// Scope: the entrypoints this hardening pass covers. src/servers/fygaro-webhook-server.ts,
// ws-server.ts, exporter.ts and trigger.ts still swallow boot failures the same
// way; converting them changes restart semantics for processes outside this
// PR's blast radius, so they are deliberately not listed here yet.
const ENTRYPOINTS = [
  "ibex-webhook-server.ts",
  "bridge-webhook-server.ts",
  "graphql-admin-server.ts",
  "graphql-main-server.ts",
]

const SERVERS_DIR = path.join(__dirname, "..", "..", "..", "..", "src", "servers")

describe("server entrypoints", () => {
  it.each(ENTRYPOINTS)("%s makes a boot failure fatal", (file) => {
    const source = fs.readFileSync(path.join(SERVERS_DIR, file), "utf8")

    const catchLines = source
      .split("\n")
      .filter((line) => line.includes(".catch(") && !line.trimStart().startsWith("//"))

    expect(catchLines.length).toBeGreaterThan(0)
    for (const line of catchLines) {
      expect(line).toContain(".catch(exitOnBootFailure)")
    }
  })
})
