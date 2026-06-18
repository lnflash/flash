import { Request, Response, NextFunction } from "express"
import requestIp from "request-ip"
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

  const clientIp = requestIp.getClientIp(req)
  if (!isIpInAllowlist(clientIp)) {
    logger.warn(
      { clientIp, path: req.path },
      "Rejected Ibex webhook request from non-allowlisted IP",
    )
    return resp.status(403).end("Forbidden")
  }
  next()
}
