// Ops alerting for Bridge integration signals (ENG-361).

export type AlertSeverity = "critical" | "warning"

export type AlertSource =
  | "bridge-webhook"
  | "bridge-api"
  | "ibex"
  | "erpnext-audit"
  | "fygaro-webhook"
  // The PRE-charge side (fygaroCheckoutCreate), as distinct from the webhook
  // that runs after the card is captured. Different blast radius: a fault here
  // refuses everyone before they pay, rather than stranding one payment.
  | "fygaro-checkout"

export interface BridgeAlert {
  dedupKey: string
  source: AlertSource
  severity: AlertSeverity
  title: string
  detail?: string
  context?: Record<string, unknown>
}
