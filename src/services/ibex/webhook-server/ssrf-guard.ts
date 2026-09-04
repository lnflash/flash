import dns from "dns"

import { AxiosRequestConfig } from "axios"

// SSRF guard for URLs derived from user-controlled data (e.g. a wallet's
// stored lnurlp, decoded and then fetched server-side by the LNURL-pay proxy).
//
// Policy (non-dev networks):
//   - https only
//   - hostname must not be an IP literal in a private/loopback/link-local/
//     reserved range, nor a well-known cloud-metadata name
//   - DNS must not resolve the host to any such address
//
// On regtest the private-IP checks are skipped and plain http is allowed so
// local dev stacks (http://localhost:3000 lnurl servers) keep working. The
// network is read at call time, not import time, so tests can flip it.

export class SsrfBlockedUrlError extends Error {
  constructor(url: string, reason: string) {
    super(`Blocked outbound fetch to ${url}: ${reason}`)
    this.name = "SsrfBlockedUrlError"
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "instance-data",
])

const isDevNetwork = () => process.env.NETWORK === "regtest"

// dotted-quad → reserved/private per RFC 6890 et al.
const isPrivateIpv4 = (ip: string): boolean => {
  const parts = ip.split(".")
  if (parts.length !== 4) return false
  const octets = parts.map((p) => Number(p))
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b, c] = octets
  return (
    a === 0 || // "this" network
    a === 10 || // RFC 1918
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local (cloud metadata lives here)
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 192 && b === 168) || // RFC 1918
    (a === 198 && (b === 18 || b === 19)) || // benchmark nets
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast + reserved
  )
}

// Handles IPv4-mapped IPv6 by unwrapping to IPv4 first — both the dotted form
// (::ffff:1.2.3.4) and the hex-serialized form WHATWG URL produces
// (::ffff:7f00:1).
const isPrivateIpv6 = (raw: string): boolean => {
  const ip = raw.toLowerCase()
  const mappedDotted = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mappedDotted) return isPrivateIpv4(mappedDotted[1])
  const mappedHex = ip.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16)
    const lo = parseInt(mappedHex[2], 16)
    return isPrivateIpv4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`)
  }
  if (
    ip === "::" ||
    ip === "::1" ||
    ip === "0:0:0:0:0:0:0:0" ||
    ip === "0:0:0:0:0:0:0:1"
  ) {
    return true
  }
  const first = ip.split(":")[0]
  const firstWord = parseInt(first || "0", 16)
  if (Number.isNaN(firstWord)) return true // unparseable → treat as unsafe
  return (
    (firstWord & 0xfe00) === 0xfc00 || // fc00::/7 unique-local
    (firstWord & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (firstWord & 0xff00) === 0xff00 || // ff00::/8 multicast
    (firstWord === 0x2001 && ip.startsWith("2001:db8")) // documentation range
  )
}

export const isPrivateIpLiteral = (host: string): boolean => {
  // WHATWG URL keeps the brackets on IPv6 literals ("[::1]") — strip them.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
  return isPrivateIpv4(bare) || (bare.includes(":") && isPrivateIpv6(bare))
}

// True for any IP literal (public or private), i.e. "nothing to DNS-resolve".
export const isIpLiteral = (host: string): boolean => {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(":")
}

// Cheap synchronous checks usable where async DNS isn't possible (redirect
// validation). Scheme + blocked names + literal IPs only.
const checkUrlSync = (url: URL): Error | null => {
  if (url.protocol !== "https:" && !(isDevNetwork() && url.protocol === "http:")) {
    return new SsrfBlockedUrlError(url.toString(), `scheme ${url.protocol} not allowed`)
  }
  if (isDevNetwork()) return null
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
    return new SsrfBlockedUrlError(rawUrl, "unparseable URL")
  }

  const syncError = checkUrlSync(url)
  if (syncError) return syncError
  if (isDevNetwork()) return url

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

// Axios options for fetching user-derived URLs: bounded redirects, each
// redirect target re-checked (sync-only — DNS re-check per redirect isn't
// possible here; the initial host IS DNS-checked), and a hard timeout so a
// hostile/slow endpoint can't tie up the server.
export const ssrfAxiosOptions: AxiosRequestConfig = {
  maxRedirects: 3,
  timeout: 10_000,
  beforeRedirect: (options: Record<string, unknown>) => {
    let url: URL
    try {
      url = new URL(String(options.href))
    } catch {
      throw new SsrfBlockedUrlError(String(options.href), "unparseable redirect URL")
    }
    const err = checkUrlSync(url)
    if (err) throw err
  },
}
