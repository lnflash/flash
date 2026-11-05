const { test } = require("node:test")
const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const path = require("node:path")
const { safeEnvironment, selection } = require("./native-parity-unit.cjs")
const guard = path.resolve(__dirname, "../test/flash/unit/native-parity-network.cjs")

test("child configuration drops credentials, environment preloads and service overrides", () => {
  const env = safeEnvironment({
    PATH: "/fixture/bin",
    TMPDIR: "/fixture/tmp",
    HOME: "/private/fixture",
    NODE_OPTIONS: "--require /private/preload.cjs",
    DOTENV_CONFIG_PATH: "/private/.env",
    NODE_ENV: "production",
    NETWORK: "mainnet",
    AWS_PROFILE: "production",
    GOOGLE_APPLICATION_CREDENTIALS: "/private/service-account.json",
    TWILIO_AUTH_TOKEN: "must-not-pass-through",
    REDIS_0_DNS: "redis.production.invalid",
    MONGODB_CON: "mongodb://production.invalid",
    HTTP_PROXY: "http://proxy.invalid",
  })
  assert.equal(env.PATH, "/fixture/bin")
  assert.equal(env.TMPDIR, "/fixture/tmp")
  for (const key of [
    "HOME",
    "NODE_OPTIONS",
    "DOTENV_CONFIG_PATH",
    "AWS_PROFILE",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "HTTP_PROXY",
  ]) {
    assert.equal(Object.hasOwn(env, key), false)
  }
  assert.equal(env.NODE_ENV, "test")
  assert.equal(env.NETWORK, "regtest")
  assert.equal(env.TWILIO_AUTH_TOKEN, "unit-fixture-not-a-live-credential")
  assert.equal(env.REDIS_0_DNS, "127.0.0.1")
  assert.match(env.MONGODB_CON, /^mongodb:\/\/127\.0\.0\.1:9\//)
})

test("suite selection cannot become an arbitrary script, integration path or Jest switch", () => {
  for (const args of [
    ["--forceExit"],
    ["--config=private.cjs"],
    ["../../integration"],
    ["bridge", "unknown"],
  ]) {
    assert.throws(() => selection(args))
  }
  const files = selection([])
  assert.equal(new Set(files).size, files.length)
  assert.ok(
    files.every(
      (file) => file.startsWith("test/flash/unit/") && file.endsWith(".spec.ts"),
    ),
  )
  assert.ok(
    files.includes("test/flash/unit/services/storage/id-document-presigned-put.spec.ts"),
  )
  assert.deepEqual(selection(["storage", "storage"]), selection(["storage"]))
})

function run(code) {
  return spawnSync(process.execPath, ["--require", guard, "-e", code], {
    env: safeEnvironment({}),
    encoding: "utf8",
    timeout: 10000,
  })
}

test("real local HTTP fixture works and exits naturally", () => {
  const result = run(`
    const http = require("node:http");
    const server = http.createServer((request, response) => response.end("fixture"));
    server.listen(0, "127.0.0.1", () => {
      http.get("http://127.0.0.1:" + server.address().port, response => {
        response.resume(); response.on("end", () => server.close());
      }).on("error", error => { console.error(error); process.exitCode=1; server.close(); });
    });
  `)
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
})

test("even caught remote, unowned loopback, DNS and UDP attempts fail the process", () => {
  for (const code of [
    'require("node:net").connect({host:"198.51.100.1",port:443})',
    'require("node:net").connect({host:"127.0.0.1",port:9})',
    'require("node:dns").lookup("provider.example.invalid",()=>{})',
    'new(require("node:dns").Resolver)().resolve4("provider.example.invalid",()=>{})',
    'const socket=require("node:dgram").createSocket("udp4");try{socket.send("x",53,"198.51.100.1")}finally{socket.close()}',
    'require("node:http").createServer().listen(0,"0.0.0.0")',
  ]) {
    const result = run(
      `try { ${code} } catch(error) { if(error.code!=="UNIT_NETWORK_BLOCKED") throw error; }`,
    )
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /Blocked 1 unmocked network attempts/)
  }
})

test("a caught fetch failure cannot hide a missing HTTP provider mock", () => {
  const result = run('fetch("https://provider.example.invalid").catch(()=>{})')
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /unmocked network attempts/)
})
