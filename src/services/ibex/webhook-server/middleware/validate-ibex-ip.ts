import { Request, Response, NextFunction } from "express"
import ipaddr from "ipaddr.js"

import { IbexConfig } from "@config"
import { baseLogger as logger } from "@services/logger"

type ParsedRange = [ipaddr.IPv4 | ipaddr.IPv6, number]

const parseAllowlistEntry = (entry: string): ParsedRange | null => {
  const trimmed = entry.trim()
  if (!trimmed) return null
  try {
    // Accept both single IPs ("1.2.3.4") and CIDR ranges ("1.2.3.0/24").
    if (trimmed.includes("/")) return ipaddr.parseCIDR(trimmed)
    const addr = ipaddr.parse(trimmed)
    return [addr, addr.kind() === "ipv6" ? 128 : 32]
  } catch {
    logger.error({ entry }, "Ignoring invalid Ibex webhook IP allowlist entry")
    return null
  }
}

export const parseAllowlist = (entries: readonly string[]): ParsedRange[] =>
  entries.map(parseAllowlistEntry).filter((r): r is ParsedRange => r !== null)

// Parsed once at module load from config.
const allowlist: ParsedRange[] = parseAllowlist(IbexConfig.webhook.allowedIps ?? [])

export const ibexWebhookIpAllowlistEnabled = allowlist.length > 0

export const isIpInAllowlist = (
  clientIp: string | null | undefined,
  ranges: ParsedRange[] = allowlist,
): boolean => {
  if (!clientIp || !ipaddr.isValid(clientIp)) return false
  // `process` normalizes IPv4-mapped IPv6 (e.g. "::ffff:1.2.3.4") back to IPv4.
  const addr = ipaddr.process(clientIp)
  return ranges.some(([rangeAddr, prefix]) => {
    if (addr.kind() === "ipv4" && rangeAddr.kind() === "ipv4") {
      return (addr as ipaddr.IPv4).match(rangeAddr as ipaddr.IPv4, prefix)
    }
    if (addr.kind() === "ipv6" && rangeAddr.kind() === "ipv6") {
      return (addr as ipaddr.IPv6).match(rangeAddr as ipaddr.IPv6, prefix)
    }
    return false
  })
}

const rejectUnlessAllowlisted = (
  ranges: ParsedRange[],
  sender: string,
  req: Request,
  resp: Response,
  next: NextFunction,
) => {
  // req.ip, not request-ip: with `trust proxy` set on the server, Express
  // resolves the proxy-appended (rightmost untrusted) X-Forwarded-For entry.
  // request-ip prefers the LEFTMOST entry, which any caller can forge to an
  // allowlisted IP and walk through this gate.
  const clientIp = req.ip ?? req.socket?.remoteAddress
  if (!isIpInAllowlist(clientIp, ranges)) {
    logger.warn(
      { clientIp, path: req.path },
      `Rejected ${sender} webhook request from non-allowlisted IP`,
    )
    return resp.status(403).end("Forbidden")
  }
  next()
}

/**
 * Reject Ibex webhook requests whose source IP is not on the configured
 * allowlist (Ibex publishes the IPs its webhooks originate from). This is
 * defense-in-depth alongside the shared `webhookSecret` check.
 *
 * Fails open when no allowlist is configured (`ibex.webhook.allowedIps` empty),
 * so payment webhooks are never blocked before an operator populates Ibex's
 * published IPs. See ISL-112.
 *
 * Apply only to authenticated Ibex-webhook routes — never to the public
 * `GET /pay/lnurl/:username` LNURL-pay endpoint, which legitimately receives
 * traffic from arbitrary payers.
 */
export const validateIbexIp = (req: Request, resp: Response, next: NextFunction) => {
  if (!ibexWebhookIpAllowlistEnabled) return next()
  rejectUnlessAllowlisted(allowlist, "Ibex", req, resp, next)
}

// IBEX Hub delivers the organization webhook (ENG-891) from its own published
// addresses, a different list from the legacy per-object webhooks above.
const hubAllowlist: ParsedRange[] = parseAllowlist(
  IbexConfig.webhook.hub?.allowedIps ?? [],
)

// Same rule for the IBEX Hub webhook route. Fails open when the list is empty;
// that route's Ed25519 signature check is never skipped.
export const validateIbexHubIp = (req: Request, resp: Response, next: NextFunction) => {
  if (hubAllowlist.length === 0) return next()
  rejectUnlessAllowlisted(hubAllowlist, "IBEX Hub", req, resp, next)
}
