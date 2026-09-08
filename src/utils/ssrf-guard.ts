import dns from "dns"
import http from "http"
import https from "https"
import { LookupFunction } from "net"

import axios, { AxiosRequestConfig, AxiosResponse } from "axios"
import ipaddr from "ipaddr.js"

import { isDevContext } from "@utils/dev-context"

// SSRF guard for URLs derived from user-controlled data. Two callers today,
// both fetching a bech32 LNURL the user chose, decoded to an arbitrary URL:
// the public LNURL-pay proxy (`GET /pay/lnurl/:username`, from the payee's
// stored lnurlp) and the `lnurlPaymentSend` mutation (from the payer's `lnurl`
// argument). It lives in @utils rather than under the webhook server because
// it is neither webhook- nor ibex-specific: anything that fetches a URL the
// caller supplied belongs behind it.
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
// NETWORK=regtest OR FLASH_DEV_UNSAFE_MODE=true (formerly, and still as a
// deprecated alias, ALLOW_REPO_DEV_SECRETS) — because the repo's own dev stack
// runs NETWORK=mainnet against the Ibex sandbox, so NETWORK alone can't mark
// it as dev. It is read at call time, not import time, so tests can flip it.
// Turning it on is what warnIfDevContext() announces at boot: this whole guard
// is off, on a public unauthenticated route.

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

// Default bound on the DNS half of validation. `dns.promises.lookup` accepts
// neither a timeout nor an AbortSignal — Node's LookupOptions is
// family/hints/all/verbatim and nothing else — so the only thing that ends a
// lookup of a blackholed domain is the OS resolver giving up: glibc's default
// is timeout:5 x attempts:2 PER nameserver, i.e. tens of seconds. Every host
// that reaches here was chosen by a user (the payee's stored lnurlp, the
// payer's `lnurl` argument, or a `Location` the host they picked returned), on
// a public unauthenticated route and — for lnurlPaymentSend — while holding
// the sender's wallet redlock.
//
// Racing a timer does not cancel the in-flight getaddrinfo: it keeps its libuv
// threadpool slot (4 by default, shared pod-wide with fs and crypto) until the
// resolver gives up. What it does is stop the request waiting on it, which is
// what a budget is for.
export const DNS_VALIDATION_TIMEOUT_MS = 5_000

class DnsBudgetExceededError extends Error {}

const lookupWithinBudget = async (
  host: string,
  timeoutMs: number,
): Promise<dns.LookupAddress[]> => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      dns.promises.lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new DnsBudgetExceededError(
                `DNS resolution exceeded the ${timeoutMs}ms budget`,
              ),
            ),
          Math.max(0, timeoutMs),
        )
        // Never hold the process open for a lookup nobody is waiting on.
        timer.unref()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// Full async validation: sync checks + DNS resolution, rejecting the host if
// ANY resolved address is private/reserved. Returns the URL or an Error.
//
// `timeoutMs` bounds the DNS half. ssrfFetch passes what is left of the chain
// budget when it validates a redirect target, so an attacker-chosen `Location`
// naming a domain whose nameservers blackhole queries cannot hold the request
// past the deadline this module advertises; direct callers get
// DNS_VALIDATION_TIMEOUT_MS.
export const validatePublicHttpUrl = async (
  rawUrl: string,
  timeoutMs: number = DNS_VALIDATION_TIMEOUT_MS,
): Promise<URL | Error> => {
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
    addresses = await lookupWithinBudget(host, timeoutMs)
  } catch (err) {
    if (err instanceof DnsBudgetExceededError) {
      return new SsrfBlockedUrlError(rawUrl, err.message)
    }
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
// 4x as long as the number says. Enforced on both halves of a hop — the
// shrinking per-hop `timeout` plus one wall-clock AbortSignal spanning the
// whole chain for the fetch (axios's `timeout` alone is an inactivity timer a
// trickling host resets forever — see the comment there), and the same
// remaining budget handed to validatePublicHttpUrl for the DNS lookup of each
// redirect target, which has no timeout of its own.
export const TOTAL_FETCH_TIMEOUT_MS = 10_000
// An LNURL-pay response is well under 2 KB. Without a cap axios buffers
// whatever an attacker-chosen host streams, and this route is public and
// unauthenticated — a user points their lnurlp at a server that never stops
// sending and OOMs the pod.
export const MAX_RESPONSE_BYTES = 64 * 1024
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

// Everything a caller may have put on the request that could carry a
// credential or a user identifier: headers (Authorization, Cookie, API keys),
// query params (signed URLs, tokens) and `auth` — which axios expands into an
// `Authorization: Basic ...` header at request time, so dropping `headers`
// alone would still hand the credential to the redirect target. Dropped before
// following a redirect to a different origin.
//
// `params` is already off the per-hop config by then (withCallerParams folds it
// into the first hop's URL below), but it stays in this list so the strip is
// still complete if a future caller path puts it back.
const withoutCallerCredentials = (config: AxiosRequestConfig): AxiosRequestConfig => {
  const stripped = { ...config }
  delete stripped.headers
  delete stripped.params
  delete stripped.auth
  return stripped
}

// The caller's `params` belong to the FIRST hop only, so they are serialised
// into its URL instead of riding on the per-hop config. axios re-serialises
// `params` onto whatever URL it is handed, and buildURL joins with `&` when
// that URL already carries a query string — so keeping them on the config
// re-appends them to every redirect target. A server that redirects
// `/invoice` to `/invoice?amount=1000` would be fetched as
// `?amount=1000&amount=1000&comment=...`, and a first-wins or last-wins
// upstream then quotes an amount the payer never asked for (on-pay.ts passes
// exactly that `{ amount, comment }`). `follow-redirects`, the library this
// manual loop replaces, never re-appended them either: whatever query string
// the `Location` carries is the one the redirect target gets.
const withCallerParams = (url: URL, params: unknown): URL => {
  if (!params || typeof params !== "object") return url
  const entries =
    params instanceof URLSearchParams
      ? [...params.entries()]
      : Object.entries(params as Record<string, unknown>)
  if (entries.length === 0) return url

  const withParams = new URL(url.toString())
  for (const [key, value] of entries) {
    // axios omits null/undefined params; matching that keeps a caller's
    // optional field from being sent as the literal string "undefined".
    if (value === undefined || value === null) continue
    withParams.searchParams.set(key, String(value))
  }
  return withParams
}

// A caller's own cancellation must still work. The guard fields deliberately
// come last so caller config can never override them, which for `signal` would
// otherwise mean silently dropping the caller's.
//
// `AxiosRequestConfig["signal"]` is axios's structural `GenericAbortSignal`
// (`{ aborted, addEventListener?, ... }`), not necessarily a real AbortSignal:
// a polyfilled or cross-realm signal type-checks, and axios honours it — its
// adapter subscribes with `addEventListener("abort", ...)` exactly as below.
// An `instanceof` narrow would drop such a signal on the floor AND overwrite
// the one riding on the caller's config, so their cancellation would stop
// working precisely because they routed the fetch through this guard. Bridge
// it onto a real signal instead. (A signal with no `addEventListener` could
// never have cancelled an axios request in the first place; its `aborted`
// state at call time is still honoured.)
const combineSignals = (
  chainSignal: AbortSignal,
  callerSignal: AxiosRequestConfig["signal"],
): AbortSignal => {
  if (!callerSignal) return chainSignal
  if (callerSignal instanceof AbortSignal) {
    return AbortSignal.any([chainSignal, callerSignal])
  }

  const bridge = new AbortController()
  if (callerSignal.aborted) {
    bridge.abort()
  } else {
    callerSignal.addEventListener?.("abort", () => bridge.abort(), { once: true })
  }
  return AbortSignal.any([chainSignal, bridge.signal])
}

// The guard imposes three limits on every hop and only one of them arrives as
// something a caller can recognise. The chain `signal` is translated in the
// catch below; the per-hop inactivity `timeout` and the body cap surface as
// ordinary AxiosErrors, so without this a host that streams 65KB or that
// accepts and then goes silent gets 500 + logger.error from the public
// unauthenticated proxy route, while the identical refusal via a redirect or a
// connect-time rebind gets 502 + logger.warn and lands on the
// `lnurlpay.blocked` span. Same attacker, same refusal class, one signal.
//
// Classified on the message rather than the code alone: axios reuses
// ERR_BAD_RESPONSE for any 5xx that fails validateStatus, and an upstream that
// is merely broken is not a blocked target.
const AXIOS_TIMEOUT_CODES = new Set(["ECONNABORTED", "ETIMEDOUT"])

const hopLimitReason = (err: unknown): string | null => {
  // Structural, like axios's own `isAxiosError`, so the check survives a test
  // (or a future caller) that stubs the axios module without that helper.
  const axiosError = err as { isAxiosError?: unknown; code?: unknown; message?: unknown }
  if (!axiosError || axiosError.isAxiosError !== true) return null

  const message = typeof axiosError.message === "string" ? axiosError.message : ""
  if (
    typeof axiosError.code === "string" &&
    AXIOS_TIMEOUT_CODES.has(axiosError.code) &&
    /timeout/i.test(message)
  ) {
    return `hop stalled — ${message} (per-hop limit inside the ${TOTAL_FETCH_TIMEOUT_MS}ms total fetch budget)`
  }
  if (/max(?:ContentLength|BodyLength)/i.test(message)) {
    return `exceeded the ${MAX_RESPONSE_BYTES}-byte body cap (${message})`
  }
  return null
}

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
  // axios's `timeout` is a socket INACTIVITY timer — it maps to
  // req.setTimeout(), which resets on every byte, and the one wall-clock timer
  // the adapter keeps (connectPhaseTimer) is cleared the moment response
  // headers arrive. So a host that answers 200 immediately and then writes one
  // byte every few seconds is never cut off by it, never reaches
  // maxContentLength, and pins a socket, an fd and a pending request for as
  // long as it likes — on a public unauthenticated route (GET
  // /pay/lnurl/:username), and while holding the sender's wallet redlock on
  // lnurlPaymentSend. Only a wall-clock abort closes that, and it has to be
  // ONE signal created before the loop: a per-hop signal would hand a 3-hop
  // chain 4x the budget this constant advertises, which is the same bug the
  // per-hop `timeout` had. AbortSignal.timeout's timer is unref'd, so it never
  // holds the process open on its own.
  const chainSignal = AbortSignal.timeout(TOTAL_FETCH_TIMEOUT_MS)
  const signal = combineSignals(chainSignal, config.signal)

  let current = withCallerParams(url, config.params)
  // Caller config for the CURRENT hop. `params` never rides along — it was
  // folded into the first hop's URL above. Narrowed further on a cross-origin
  // redirect — see withoutCallerCredentials below.
  let hopConfig: AxiosRequestConfig = { ...config }
  delete hopConfig.params
  for (let hop = 0; ; hop++) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw new SsrfBlockedUrlError(
        url.toString(),
        `exceeded the ${TOTAL_FETCH_TIMEOUT_MS}ms total fetch budget`,
      )
    }

    let resp: AxiosResponse
    try {
      resp = await axios.get(current.toString(), {
        ...hopConfig,
        // Guard fields come LAST so caller config can never silently override
        // them: the agents re-validate DNS at connect time (the TOCTOU half of
        // the guard), the body size and the total time are capped, and axios's
        // unchecked built-in redirect following must stay disabled — every 3xx
        // target is re-validated manually below.
        ...ssrfAgents,
        // Both limits are needed, and they catch different hosts: `timeout`
        // cuts a hop that goes quiet, `signal` cuts one that keeps dribbling.
        timeout: remainingMs,
        signal,
        maxContentLength: MAX_RESPONSE_BYTES,
        maxBodyLength: MAX_RESPONSE_BYTES,
        maxRedirects: 0,
        // 3xx is not an error here — redirects are followed manually so each
        // target gets the full async (DNS) validation first.
        validateStatus: (status) => status >= 200 && status < 400,
      })
    } catch (err) {
      // The chain abort surfaces as an axios CanceledError, which callers
      // would answer with a 500: isSsrfBlockedError is what maps a refused
      // fetch to the 502 every other blocked-target case returns. Report the
      // budget for what it is, in the same shape as the between-hops check
      // above. A caller's own signal firing is not ours to relabel.
      if (chainSignal.aborted) {
        throw new SsrfBlockedUrlError(
          url.toString(),
          `exceeded the ${TOTAL_FETCH_TIMEOUT_MS}ms total fetch budget`,
        )
      }
      // The other two limits this guard sets — the per-hop timeout and the
      // body cap — come back as plain AxiosErrors. Report them as the
      // refusals they are, so every limit the guard advertises reaches the
      // caller through the single isSsrfBlockedError branch. Named by the hop
      // that actually failed, which on a redirect chain is a different host
      // from the URL the caller handed in.
      const limitReason = hopLimitReason(err)
      if (limitReason) throw new SsrfBlockedUrlError(current.toString(), limitReason)
      throw err
    }

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
    // A malformed Location (`Location: http://`) makes `new URL` throw a bare
    // TypeError, and an unwrapped TypeError escapes ssrfFetch as a
    // non-SsrfBlockedUrlError: the proxy route then falls past
    // isSsrfBlockedError into logger.error + 500 instead of the 502 every
    // other blocked-target case returns, letting an attacker-chosen host pick
    // the status code and log level the pod emits.
    let nextRaw: string
    try {
      nextRaw = new URL(location, current).toString()
    } catch {
      throw new SsrfBlockedUrlError(url.toString(), "unparsable redirect Location")
    }
    // The DNS half of validation gets what is left of the chain budget: it
    // runs AFTER the per-iteration check above, and an unbounded lookup of an
    // attacker-named host would blow through the deadline all over again.
    const next = await validatePublicHttpUrl(nextRaw, deadline - Date.now())
    if (next instanceof Error) throw next
    // Redirect targets are attacker-chosen on these routes: the user picks the
    // lnurl host, and that host picks the Location. `follow-redirects`
    // — the library this manual loop replaces — strips Authorization/Cookie on a
    // cross-host redirect for exactly that reason, so this loop has to as well,
    // or a caller that adds an API-key header hands it to whatever host a user's
    // lnurlp redirects to. No caller sends credentials today; this is a shared
    // security utility, and the next one must not have to know.
    if (next.origin !== current.origin) hopConfig = withoutCallerCredentials(hopConfig)
    current = next
  }
}
