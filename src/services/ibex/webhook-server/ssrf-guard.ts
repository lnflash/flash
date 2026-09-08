import dns from "dns"
import http from "http"
import https from "https"
import { LookupFunction } from "net"

import axios, { AxiosRequestConfig, AxiosResponse } from "axios"
import ipaddr from "ipaddr.js"

import { isDevContext } from "@utils/dev-context"

// SSRF guard for URLs derived from user-controlled data (e.g. a wallet's
// stored lnurlp, decoded and then fetched server-side by the LNURL-pay proxy).
//
// Policy (deployed environments):
//   - https only
//   - hostname must not be an IP literal outside the public unicast range,
//     nor a well-known cloud-metadata name
//   - DNS must not resolve the host to any such address, at validation time
//     AND again at connect time
//   - the response body is capped, and the whole redirect chain shares one
//     time budget
//
// In a dev context the private-IP checks are skipped and plain http is
// allowed so local dev stacks (http://localhost:3000 lnurl servers) keep
// working. "Dev context" is the shared predicate in @utils/dev-context —
// NETWORK=regtest OR ALLOW_REPO_DEV_SECRETS=true — because the repo's own dev
// stack runs NETWORK=mainnet against the Ibex sandbox, so NETWORK alone can't
// mark it as dev. It is read at call time, not import time, so tests can flip
// it.

export class SsrfBlockedUrlError extends Error {
  constructor(url: string, reason: string) {
    super(`Blocked outbound fetch to ${url}: ${reason}`)
    this.name = "SsrfBlockedUrlError"
  }
}

// A connect-time refusal happens inside the socket's lookup, so axios hands
// the caller an AxiosError with the SsrfBlockedUrlError as its `cause` — an
// `instanceof` on the top-level error alone would miss exactly the rebind case
// the connect-time check exists to catch, and the route would answer 500
// instead of "blocked upstream URL".
export const isSsrfBlockedError = (err: unknown): boolean => {
  let cursor: unknown = err
  for (let depth = 0; cursor instanceof Error && depth < 5; depth++) {
    if (cursor instanceof SsrfBlockedUrlError) return true
    cursor = (cursor as { cause?: unknown }).cause
  }
  return false
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "instance-data",
])

// ipaddr.js sorts every address into exactly one range, and "unicast" is the
// only one that means "an ordinary routable public address". Everything else
// either points inside our own network (private, loopback, linkLocal,
// uniqueLocal, carrierGradeNat, unspecified, broadcast, multicast, reserved)
// or is a translation/tunnel prefix that carries one of those inside a
// public-looking address (ipv4Mapped, rfc6052 NAT64, 6to4, teredo). The NAT64
// case is not theoretical: on a DNS64 network — how IPv6-only node pools reach
// IPv4 — the resolver synthesises 64:ff9b::a9fe:a9fe for a host whose A record
// is 169.254.169.254.
//
// Using the library (already a direct dependency, already used for exactly
// this job in ./middleware/validate-ibex-ip.ts) instead of hand-rolled octet
// arithmetic is what keeps that list complete as new prefixes are assigned.
const PUBLIC_RANGE = "unicast"

const stripBrackets = (host: string): string =>
  host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host

// True for any IP literal (public or private), i.e. "nothing to DNS-resolve".
export const isIpLiteral = (host: string): boolean => {
  const bare = stripBrackets(host)
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(":")
}

// True for anything that is not a public unicast address. Hostnames answer
// false — they are not literals, so DNS resolution decides for them — but a
// literal-shaped string ipaddr can't parse fails closed.
export const isPrivateIpLiteral = (host: string): boolean => {
  const bare = stripBrackets(host)
  if (!ipaddr.isValid(bare)) return isIpLiteral(bare)
  return ipaddr.parse(bare).range() !== PUBLIC_RANGE
}

// Scheme, blocked-name and literal-IP checks — the half of the policy that
// needs no network IO. The DNS half lives in validatePublicHttpUrl, which is
// what every caller (including redirect validation) actually uses.
const checkUrlSync = (url: URL): Error | null => {
  if (url.protocol !== "https:" && !(isDevContext() && url.protocol === "http:")) {
    return new SsrfBlockedUrlError(url.toString(), `scheme ${url.protocol} not allowed`)
  }
  if (isDevContext()) return null
  const host = url.hostname.toLowerCase()
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost")) {
    return new SsrfBlockedUrlError(url.toString(), "blocked hostname")
  }
  if (isPrivateIpLiteral(host)) {
    return new SsrfBlockedUrlError(url.toString(), "private/reserved IP literal")
  }
  return null
}

// Full async validation: sync checks + DNS resolution, rejecting the host if
// ANY resolved address is private/reserved. Returns the URL or an Error.
export const validatePublicHttpUrl = async (rawUrl: string): Promise<URL | Error> => {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return new SsrfBlockedUrlError(rawUrl, "unparsable URL")
  }

  const syncError = checkUrlSync(url)
  if (syncError) return syncError
  if (isDevContext()) return url

  const host = url.hostname.toLowerCase()
  // Literals need no resolution — private ones were already rejected above.
  if (isIpLiteral(host)) return url

  let addresses: dns.LookupAddress[]
  try {
    addresses = await dns.promises.lookup(host, { all: true, verbatim: true })
  } catch (err) {
    return new SsrfBlockedUrlError(rawUrl, `DNS resolution failed: ${err}`)
  }
  if (addresses.length === 0) {
    return new SsrfBlockedUrlError(rawUrl, "DNS returned no addresses")
  }
  for (const { address } of addresses) {
    if (isPrivateIpLiteral(address)) {
      return new SsrfBlockedUrlError(rawUrl, `resolves to private address ${address}`)
    }
  }
  return url
}

// Connect-time DNS validation, plugged into the HTTP(S) agents axios uses.
// The address handed to the socket is the one that has been checked — this
// closes the validate-then-fetch TOCTOU where a short-TTL rebind swaps the DNS
// answer between our async check and axios's own resolution.
//
// Contract note: `options.all` MUST be honoured. Node >= 20 defaults
// autoSelectFamily to true, so net.connect calls this with { all: true } and
// then expects callback(err, LookupAddress[]). Handing it a bare string there
// makes every hostname connection die with ERR_INVALID_IP_ADDRESS — see the
// socket-level spec, which connects for real rather than mocking the agents.
export const ssrfLookup: LookupFunction = (hostname, options, callback) => {
  const opts: dns.LookupOptions = typeof options === "object" && options ? options : {}
  // Forward what the socket asked for (family/hints) so the answers we
  // validate are the answers it would have gotten on its own; `all` is forced
  // on because every address has to be checked, not just the first.
  const resolveOptions: dns.LookupAllOptions = { all: true, verbatim: true }
  if (typeof opts.family === "number") resolveOptions.family = opts.family
  if (typeof opts.hints === "number") resolveOptions.hints = opts.hints

  const fail = (err: Error) => callback(err as NodeJS.ErrnoException, "", 4)

  dns.promises
    .lookup(hostname, resolveOptions)
    .then((addresses) => {
      if (!isDevContext()) {
        for (const { address } of addresses) {
          if (isPrivateIpLiteral(address)) {
            fail(
              new SsrfBlockedUrlError(
                hostname,
                `connect-time DNS resolved to private address ${address}`,
              ),
            )
            return
          }
        }
      }
      if (addresses.length === 0) {
        fail(new SsrfBlockedUrlError(hostname, "connect-time DNS returned no addresses"))
        return
      }
      // Every address passed the check, so happy-eyeballs may use any of them.
      if (opts.all) {
        callback(null, addresses)
        return
      }
      callback(null, addresses[0].address, addresses[0].family)
    })
    .catch((err) => fail(err as Error))
}

const ssrfAgents = {
  httpAgent: new http.Agent({ lookup: ssrfLookup }),
  httpsAgent: new https.Agent({ lookup: ssrfLookup }),
}

export const MAX_REDIRECT_HOPS = 3
// One budget for the whole chain, not per hop: with a per-hop timeout a
// 3-hop chain of slow-loris responses pins a request (and an API worker) for
// 4x as long as the number says.
export const TOTAL_FETCH_TIMEOUT_MS = 10_000
// An LNURL-pay response is well under 2 KB. Without a cap axios buffers
// whatever an attacker-chosen host streams, and this route is public and
// unauthenticated — a user points their lnurlp at a server that never stops
// sending and OOMs the pod.
export const MAX_RESPONSE_BYTES = 64 * 1024
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

// Fetch a previously validated URL, following redirects manually: axios's
// built-in redirect following can only re-check targets synchronously (no
// DNS), so a public first hop could 302 to a host that resolves into the
// internal network. Here every hop target goes through the full async
// validatePublicHttpUrl before being fetched, and the agents above re-validate
// the resolved address again at connect time.
export const ssrfFetch = async (
  url: URL,
  config: AxiosRequestConfig = {},
): Promise<AxiosResponse> => {
  const deadline = Date.now() + TOTAL_FETCH_TIMEOUT_MS
  let current = url
  for (let hop = 0; ; hop++) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw new SsrfBlockedUrlError(
        url.toString(),
        `exceeded the ${TOTAL_FETCH_TIMEOUT_MS}ms total fetch budget`,
      )
    }

    const resp = await axios.get(current.toString(), {
      ...config,
      // Guard fields come LAST so caller config can never silently override
      // them: the agents re-validate DNS at connect time (the TOCTOU half of
      // the guard), the body size and the total time are capped, and axios's
      // unchecked built-in redirect following must stay disabled — every 3xx
      // target is re-validated manually below.
      ...ssrfAgents,
      timeout: remainingMs,
      maxContentLength: MAX_RESPONSE_BYTES,
      maxBodyLength: MAX_RESPONSE_BYTES,
      maxRedirects: 0,
      // 3xx is not an error here — redirects are followed manually so each
      // target gets the full async (DNS) validation first.
      validateStatus: (status) => status >= 200 && status < 400,
    })

    const location: unknown = resp.headers?.location
    if (!REDIRECT_STATUSES.has(resp.status) || typeof location !== "string") {
      return resp
    }
    if (hop >= MAX_REDIRECT_HOPS) {
      throw new SsrfBlockedUrlError(
        url.toString(),
        `too many redirects (limit ${MAX_REDIRECT_HOPS})`,
      )
    }
    const next = await validatePublicHttpUrl(new URL(location, current).toString())
    if (next instanceof Error) throw next
    current = next
  }
}
