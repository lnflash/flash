// Ops alerting for Bridge integration signals (ENG-361).

export type AlertSeverity = "critical" | "warning"

export type AlertSource = "bridge-webhook" | "bridge-api" | "ibex" | "erpnext-audit"

export interface BridgeAlert {
  source: AlertSource
  severity: AlertSeverity
  title: string
  detail?: string
  context?: Record<string, unknown>
}
