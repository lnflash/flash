import ipaddr from "ipaddr.js"

// Runtime counterpart of `checkedToApiKeyIpConstraints` (which validates
// entries at key creation): decides whether a client IP satisfies a key's
// stored constraints. Empty constraints ⇒ any IP is allowed. Bare-IP entries
// match on address equality, CIDR entries on range membership. `ipaddr.process`
// normalizes IPv4-mapped IPv6 (e.g. "::ffff:10.0.0.1") back to IPv4 so such
// clients still match IPv4 entries. Mismatched address families simply don't
// match, malformed entries are skipped, and a garbage `ip` returns false —
// this never throws.
export const isIpAllowedByConstraints = ({
  ip,
  constraints,
}: {
  ip: string
  constraints: string[]
}): boolean => {
  if (constraints.length === 0) return true

  let addr: ipaddr.IPv4 | ipaddr.IPv6
  try {
    if (!ipaddr.isValid(ip)) return false
    addr = ipaddr.process(ip)
  } catch {
    return false
  }

  return constraints.some((entry) => {
    try {
      if (entry.includes("/")) {
        const [rangeAddr, prefix] = ipaddr.parseCIDR(entry)
        if (addr.kind() === "ipv4" && rangeAddr.kind() === "ipv4") {
          return (addr as ipaddr.IPv4).match(rangeAddr as ipaddr.IPv4, prefix)
        }
        if (addr.kind() === "ipv6" && rangeAddr.kind() === "ipv6") {
          return (addr as ipaddr.IPv6).match(rangeAddr as ipaddr.IPv6, prefix)
        }
        return false
      }
      const entryAddr = ipaddr.process(entry)
      return addr.kind() === entryAddr.kind() && addr.toString() === entryAddr.toString()
    } catch {
      // Malformed entries were rejected at creation; skip defensively here.
      return false
    }
  })
}
