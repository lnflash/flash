// Defense against an accidentally unmocked dependency in the fixed unit slice.
// Permit only TCP connections to loopback servers created in this test process.
// This is a test interlock, not a sandbox for hostile/untrusted JavaScript.
const net = require("node:net")
const dns = require("node:dns")
const dgram = require("node:dgram")
const ports = new Set()
let violations = 0
const reject = () => {
  violations += 1
  const error = new Error("Unmocked network access blocked by native parity unit runner")
  error.code = "UNIT_NETWORK_BLOCKED"
  // Static error and code frames only: never print URLs, headers or payloads.
  console.error(error.stack)
  throw error
}
const loopback = (host) => host === "127.0.0.1" || host === "::1"
const listen = net.Server.prototype.listen
net.Server.prototype.listen = function (...args) {
  const options = args[0]
  const host = typeof options === "object" ? options.host : args[1]
  const port = typeof options === "object" ? options.port : options
  if (!loopback(host) || port !== 0) return reject()
  this.once("listening", () => {
    const address = this.address()
    if (address && typeof address === "object") {
      ports.add(address.port)
      this.once("close", () => ports.delete(address.port))
    }
  })
  return listen.apply(this, args)
}
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args
  const options = normalized[0]
  const host = typeof options === "object" ? options.host : normalized[1]
  const port = Number(typeof options === "object" ? options.port : options)
  if (!loopback(host) || !ports.has(port)) return reject()
  return connect.apply(this, args)
}
// Node's Server.listen invokes lookup even for a numeric loopback literal;
// lookup returns that literal without contacting a DNS resolver.
const lookup = dns.lookup
const promiseLookup = dns.promises.lookup
dns.lookup = (host, ...args) => (loopback(host) ? lookup(host, ...args) : reject())
dns.promises.lookup = async (host, ...args) =>
  loopback(host) ? promiseLookup(host, ...args) : reject()
for (const target of [
  dns,
  dns.promises,
  dns.Resolver.prototype,
  dns.promises.Resolver.prototype,
]) {
  for (const name of Object.getOwnPropertyNames(target)) {
    if (name.startsWith("resolve") || name === "reverse" || name === "lookupService") {
      target[name] = reject
    }
  }
}
dgram.Socket.prototype.send = reject
process.on("beforeExit", () => {
  if (violations) {
    console.error(`Blocked ${violations} unmocked network attempts; unit run fails`)
    process.exitCode = 1
  }
})
